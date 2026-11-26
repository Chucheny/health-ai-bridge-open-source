// Immutable observations, not source versions. No Huawei login, network or raw response persistence.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { requireScope } from './database.mts';
import type { Principal, Sql } from './database.mts';
import { ApiError, contentHash, cursor, instantFromNs, ns } from './protocol.mts';
import { verifyTrainingCampSleepCapture } from './trainingcamp-capture.mts';
import { TRAININGCAMP_SOURCE, type TrainingCampQuery } from './trainingcamp-store.mts';

const sleepType = 'SleepSessionRecord';
const schema = z.strictObject({
  schemaVersion: z.literal(1), batchId: z.uuid(), source: z.literal('huawei_trainingcamp'),
  // Chosen independently by the importing user, never inferred from capture metadata.
  authorizedWindow: z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }),
  capture: z.unknown(),
});
export function parseTrainingCampSleepImport(input: unknown) {
  try {
    const batch = schema.parse(input);
    const verified = verifyTrainingCampSleepCapture(batch.capture, batch.authorizedWindow);
    return { batchId: batch.batchId, authorizedWindow: batch.authorizedWindow,
      requestedWindow: verified.requestedWindow, sourceCollectedAt: verified.sourceCollectedAt,
      records: verified.records };
  } catch { throw new ApiError(400, 'invalid_trainingcamp_sleep_import'); }
}

/** Original authenticate() account lock + transaction covers snapshot, records and receipt. */
export async function importTrainingCampSleep(sql: Sql, p: Principal,
  batch: ReturnType<typeof parseTrainingCampSleepImport>) {
  requireScope(p, 'sync', sleepType);
  const requestHash = contentHash(['trainingcamp_sleep_import_v1', batch]);
  const old = (await sql.query(`SELECT request_hash,receipt FROM health_bridge.sync_batches
    WHERE owner_id=$1 AND source_id=$2 AND batch_id=$3`, [p.owner, p.source, batch.batchId])).rows[0];
  if (old) {
    if (old.request_hash !== requestHash) throw new ApiError(409, 'batch_id_reused');
    return old.receipt;
  }
  // Collection time is not a source modification/version. Equivalent instants normalize for identity.
  // Record order is retained: repeated IDs and identical sessions are never silently discarded.
  const lo = ns(batch.requestedWindow.start).toString(), hi = ns(batch.requestedWindow.end).toString();
  const digest = contentHash(['trainingcamp_sleep_snapshot_v1', lo, hi, batch.records]);
  const prior = (await sql.query(`SELECT snapshot_id FROM health_bridge.trainingcamp_sleep_snapshots
    WHERE owner_id=$1 AND source_id=$2 AND content_hash=$3`, [p.owner, p.source, digest])).rows[0];
  const snapshotId: string = prior?.snapshot_id ?? randomUUID();
  if (!prior) {
    await sql.query(`INSERT INTO health_bridge.trainingcamp_sleep_snapshots
      (snapshot_id,owner_id,source_id,content_hash,requested_start_ns,requested_end_ns,first_collected_at)
      VALUES($1,$2,$3,$4,$5::numeric,$6::numeric,$7::timestamptz)`,
    [snapshotId, p.owner, p.source, digest, lo, hi, batch.sourceCollectedAt]);
    if (batch.records.length) await sql.query(`INSERT INTO health_bridge.trainingcamp_sleep_records
      (snapshot_id,owner_id,source_id,ordinal,start_ns,end_ns,payload)
      SELECT $1,$2,$3,x.ordinal,x.start,x.finish,x.payload FROM jsonb_to_recordset($4::jsonb)
      AS x(ordinal integer,start numeric,finish numeric,payload jsonb)`,
    [snapshotId, p.owner, p.source, JSON.stringify(batch.records.map((record, ordinal) => ({
      ordinal, start: record.rawStartTime, finish: record.rawEndTime, payload: record,
    })))]);
  }
  const receipt = { batchId: batch.batchId, source: TRAININGCAMP_SOURCE, committed: true,
    committedAt: new Date().toISOString(), snapshotId, snapshotCreated: !prior,
    receivedRecords: batch.records.length, sourceCompleteness: 'unknown',
    sourceVersion: 'unavailable', snapshotSemantics: 'immutable_observation_not_latest', deletionDetection: 'not_available' };
  await sql.query(`INSERT INTO health_bridge.sync_batches(owner_id,source_id,batch_id,request_hash,receipt)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [p.owner, p.source, batch.batchId, requestHash, JSON.stringify(receipt)]);
  return receipt;
}

const selection = `owner_id=$1 AND snapshot_id=$2 AND start_ns<$4::numeric AND end_ns>$3::numeric
  AND ($5::numeric IS NULL OR (start_ns>=$5::numeric AND end_ns<=$6::numeric))`;
const params = (p: Principal, q: TrainingCampQuery) => [p.owner, q.snapshot,
  ns(q.start).toString(), ns(q.end).toString(), q.readWindow ? ns(q.readWindow.start).toString() : null,
  q.readWindow ? ns(q.readWindow.end).toString() : null];
async function requireSnapshot(sql: Sql, p: Principal, q: TrainingCampQuery) {
  requireScope(p, 'read', sleepType);
  if (q.type !== sleepType || !q.snapshot) throw new ApiError(400, 'sleep_snapshot_required');
  if (q.origin !== null) throw new ApiError(403, 'origin_not_allowed');
  if (!(await sql.query(`SELECT 1 FROM health_bridge.trainingcamp_sleep_snapshots
    WHERE owner_id=$1 AND snapshot_id=$2`, [p.owner, q.snapshot])).rows.length) {
    throw new ApiError(404, 'sleep_snapshot_not_found');
  }
}
const policy = (q: TrainingCampQuery) => ({ requiredSource: TRAININGCAMP_SOURCE, fallbackUsed: false,
  crossSourceMerge: 'not_performed', snapshotId: q.snapshot, sourceVersion: 'unavailable',
  snapshotSemantics: 'immutable_observation_not_latest', sourceCompleteness: 'unknown' });

export async function trainingCampSleepRecords(sql: Sql, p: Principal, q: TrainingCampQuery, maxBytes = 180 * 1024) {
  await requireSnapshot(sql, p, q);
  if (q.sleepStages === 'paged') return pagedSleepStages(sql, p, q, maxBytes);
  const rows = (await sql.query(`SELECT record_key::text,source_id,payload FROM health_bridge.trainingcamp_sleep_records
    WHERE ${selection} AND record_key>$7::bigint ORDER BY trainingcamp_sleep_records.record_key LIMIT $8`,
  [...params(p, q), q.after, q.limit + 1])).rows;
  const records = []; let bytes = 0, after = q.after;
  for (const row of rows.slice(0, q.limit)) {
    const item = { sourceId: row.source_id, source: TRAININGCAMP_SOURCE, snapshotId: q.snapshot, record: row.payload };
    const size = Buffer.byteLength(JSON.stringify(item));
    if (bytes + size > maxBytes) {
      if (!records.length) throw new ApiError(413, 'record_exceeds_response_limit');
      break;
    }
    records.push(item); bytes += size; after = row.record_key;
  }
  return { records, nextCursor: rows.length > records.length ? cursor(q, after) : null, sourcePolicy: policy(q),
    semantics: 'complete sessions and all stages from one immutable snapshot; overlap [start,end); no deduplication or latest-version inference' };
}

/** Explicit mode: one session fragment per page. Slice in SQL, never fetch the full stage array. */
async function pagedSleepStages(sql: Sql, p: Principal, q: TrainingCampQuery, maxBytes: number) {
  const offset = q.stageOffset ?? 0;
  const rows = (await sql.query(`SELECT record_key::text,source_id,payload-'stages' AS session,
    jsonb_array_length(payload->'stages') AS total FROM health_bridge.trainingcamp_sleep_records
    WHERE ${selection} AND record_key ${offset > 0 ? '>=' : '>'} $7::bigint ORDER BY trainingcamp_sleep_records.record_key LIMIT 2`,
  [...params(p, q), q.after])).rows;
  if (offset > 0 && (!rows.length || rows[0].record_key !== q.after || offset >= rows[0].total)) {
    throw new ApiError(400, 'invalid_cursor');
  }
  const row = rows[0];
  if (!row) return { records: [], nextCursor: null, sourcePolicy: policy(q),
    semantics: 'explicit stage paging; no matching sessions in this immutable snapshot' };
  const stages = (await sql.query(`SELECT payload->'stages'->i AS stage
    FROM health_bridge.trainingcamp_sleep_records
    CROSS JOIN LATERAL generate_series($8::integer,LEAST($9::integer,jsonb_array_length(payload->'stages')-1)) AS i
    WHERE ${selection} AND record_key=$7::bigint ORDER BY i`,
  [...params(p, q), row.record_key, offset, offset + 199])).rows.map(r => r.stage);
  const item = { sourceId: row.source_id, source: TRAININGCAMP_SOURCE, snapshotId: q.snapshot,
    // record_key is scoped to this snapshot/owner, not the unverified Huawei ID.
    sessionKey: row.record_key, record: { ...row.session, stages: [] as unknown[] },
    stagePage: { startIndex: offset, returned: 0, total: row.total as number, sessionComplete: row.total === 0 } };
  if (Buffer.byteLength(JSON.stringify(item)) > maxBytes) throw new ApiError(413, 'sleep_session_metadata_exceeds_response_limit');
  for (const stage of stages) {
    item.record.stages.push(stage);
    item.stagePage.returned = item.record.stages.length;
    item.stagePage.sessionComplete = offset + item.stagePage.returned === row.total;
    if (Buffer.byteLength(JSON.stringify(item)) > maxBytes) {
      item.record.stages.pop();
      item.stagePage.returned = item.record.stages.length;
      item.stagePage.sessionComplete = offset + item.stagePage.returned === row.total;
      if (!item.stagePage.returned) throw new ApiError(413, 'sleep_stage_exceeds_response_limit');
      break;
    }
  }
  const complete = item.stagePage.sessionComplete;
  const nextCursor = !complete || rows.length > 1 ? Buffer.from(JSON.stringify({
    f: q.fingerprint, a: row.record_key, o: complete ? 0 : offset + item.stagePage.returned,
  })).toString('base64url') : null;
  return { records: [item], nextCursor, sourcePolicy: policy(q),
    semantics: 'explicit stage paging; one session fragment per page; concatenate stages by sessionKey and startIndex until sessionComplete; do not count fragments as sessions; follow nextCursor to null; original stage order and precision retained' };
}

export async function trainingCampSleepSummary(sql: Sql, p: Principal, q: TrainingCampQuery) {
  if (q.sleepStages) throw new ApiError(400, 'sleep_stage_paging_not_supported');
  await requireSnapshot(sql, p, q);
  const rows = (await sql.query(`SELECT payload->>'sleepKind' AS sleep_kind,count(*)::text AS records_count,
    min(start_ns)::text AS first_ns,max(end_ns)::text AS last_ns
    FROM health_bridge.trainingcamp_sleep_records WHERE ${selection}
    GROUP BY payload->>'sleepKind' ORDER BY sleep_kind`, params(p, q))).rows;
  return { bySource: rows.map(row => ({ source: TRAININGCAMP_SOURCE, sleepKind: row.sleep_kind,
    records_count: row.records_count,
    recordTimeBounds: { earliestStart: instantFromNs(row.first_ns), latestEnd: instantFromNs(row.last_ns) } })),
    sourcePolicy: policy(q), metrics: 'session counts by explicit source sleep type and time bounds only; counts are not nights; no summed duration, coverage or recovery inference' };
}

function parseSleepCatalogQuery(url: URL, owner: string) {
  try {
    const allowed = new Set(['start', 'end', 'limit', 'cursor']);
    if ([...url.searchParams.keys()].some(key => !allowed.has(key) || url.searchParams.getAll(key).length !== 1)) throw new Error();
    const lo = ns(url.searchParams.get('start') ?? ''), hi = ns(url.searchParams.get('end') ?? '');
    const limit = Number(url.searchParams.get('limit') ?? 20);
    if (lo >= hi || hi - lo > 31n * 86400n * 1000000000n || !Number.isSafeInteger(limit) || limit < 1 || limit > 20) throw new Error();
    const fingerprint = contentHash(['trainingcamp_sleep_catalog_v1', owner, lo.toString(), hi.toString()]);
    let after = '00000000-0000-0000-0000-000000000000';
    if (url.searchParams.has('cursor')) {
      const c = JSON.parse(Buffer.from(url.searchParams.get('cursor')!, 'base64url').toString());
      if (c.f !== fingerprint || !z.uuid().safeParse(c.a).success) throw new Error();
      after = c.a;
    }
    return { lo, hi, limit, fingerprint, after };
  } catch { throw new ApiError(400, 'invalid_sleep_catalog_query'); }
}
/** Bounded live catalog for the local import/selection client; never chooses a latest snapshot. */
export async function trainingCampSleepSnapshots(sql: Sql, p: Principal, url: URL) {
  requireScope(p, 'read', sleepType);
  const { lo, hi, limit, fingerprint, after } = parseSleepCatalogQuery(url, p.owner);
  const rows = (await sql.query(`SELECT s.snapshot_id,s.source_id,s.requested_start_ns::text,s.requested_end_ns::text,
      s.first_collected_at,s.imported_at,(SELECT count(*)::text FROM health_bridge.trainingcamp_sleep_records r
        WHERE r.owner_id=s.owner_id AND r.snapshot_id=s.snapshot_id) AS session_count
      FROM health_bridge.trainingcamp_sleep_snapshots s WHERE s.owner_id=$1
      AND s.requested_start_ns>=$2::numeric AND s.requested_end_ns<=$3::numeric
      AND s.snapshot_id>$4::uuid ORDER BY s.snapshot_id LIMIT $5`,
    [p.owner, lo.toString(), hi.toString(), after, limit + 1])).rows;
  const snapshots = rows.slice(0, limit).map(row => ({ snapshotId: row.snapshot_id, sourceId: row.source_id,
    requestedWindow: { start: instantFromNs(row.requested_start_ns), end: instantFromNs(row.requested_end_ns) },
    captureReportedAt: new Date(row.first_collected_at).toISOString(), importedAt: new Date(row.imported_at).toISOString(),
    sessionCount: Number(row.session_count), sourceCompleteness: 'unknown', sourceVersion: 'unavailable' }));
  return { snapshots, nextCursor: rows.length > limit ? Buffer.from(JSON.stringify({
    f: fingerprint, a: snapshots.at(-1)!.snapshotId,
  })).toString('base64url') : null, source: TRAININGCAMP_SOURCE,
    semantics: 'live catalog of observations wholly contained in requested window; UUID order, not recency; no latest version or completeness inference' };
}
