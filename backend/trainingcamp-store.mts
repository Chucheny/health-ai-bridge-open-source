// Integration with the existing authenticated backend; no Huawei login or network calls.
import { z } from 'zod';
import type { Principal, Sql } from './database.mts';
import { requireScope } from './database.mts';
import { ApiError, contentHash, cursor, hash, instantFromNs, ns, parseQuery } from './protocol.mts';
import type { Query } from './protocol.mts';
import { inspectTrainingCampActivities } from './trainingcamp-semantics.mts';
import { trainingCampWorkoutMetrics } from './trainingcamp-workout-metrics.mts';
import { WEB_READ_TYPES } from './bridge-sources.mts';

export const TRAININGCAMP_SOURCE = 'huawei_trainingcamp';
const exerciseType = 'ExerciseSessionRecord';
const millis = z.union([z.number().int().safe().nonnegative(), z.string().regex(/^\d{1,16}$/)])
  .transform(String).refine(value => BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const importSchema = z.strictObject({
  schemaVersion: z.literal(1), batchId: z.uuid(),
  source: z.literal(TRAININGCAMP_SOURCE),
  requestedWindow: z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) }),
  // Validate source structure below; no Android metadata, credentials or owner fields accepted here.
  records: z.array(z.unknown()).max(100),
});

export function parseTrainingCampImport(input: unknown) {
  try {
    const batch = importSchema.parse(input);
    const lo = ns(batch.requestedWindow.start), hi = ns(batch.requestedWindow.end);
    if (lo >= hi || hi - lo > 31n * 86400n * 1000000000n) throw new Error();
    const normalized = inspectTrainingCampActivities(batch.records);
    const versions = z.array(z.object({ modifyTime: millis })).parse(batch.records);
    const seen = new Set<string>();
    const records = normalized.records.map((record, index) => {
      if (seen.has(record.sourceRecordId)) throw new Error();
      seen.add(record.sourceRecordId);
      const start = BigInt(record.startTimeMs) * 1000000n;
      const end = BigInt(record.endTimeMs) * 1000000n;
      if (start < lo || start >= hi || end > hi) throw new Error();
      return { ...record, sourceModifiedTimeMs: versions[index].modifyTime };
    });
    // Hash only validated, retained fields; do not persist unrelated device/account metadata.
    return { schemaVersion: batch.schemaVersion, batchId: batch.batchId, source: batch.source,
      requestedWindow: batch.requestedWindow, records };
  } catch { throw new ApiError(400, 'invalid_trainingcamp_import'); }
}

/** authenticate() must hold the existing account lock; receipt and writes share its transaction. */
export async function importTrainingCampActivities(sql: Sql, p: Principal,
  batch: ReturnType<typeof parseTrainingCampImport>) {
  requireScope(p, 'sync', exerciseType);
  const requestHash = contentHash(['trainingcamp_activity_import_v1', batch]);
  const old = (await sql.query(`SELECT request_hash,receipt FROM health_bridge.sync_batches
    WHERE owner_id=$1 AND source_id=$2 AND batch_id=$3`, [p.owner, p.source, batch.batchId])).rows[0];
  if (old) {
    if (old.request_hash !== requestHash) throw new ApiError(409, 'batch_id_reused');
    return old.receipt;
  }
  const stored = batch.records.length ? (await sql.query(`SELECT source_record_id,modified_ms::text,payload_hash
    FROM health_bridge.trainingcamp_activities WHERE owner_id=$1 AND source_id=$2
    AND source_record_id=ANY($3::text[])`, [p.owner, p.source, batch.records.map(r => r.sourceRecordId)])).rows : [];
  const byId = new Map(stored.map(row => [row.source_record_id, row]));
  const rows = batch.records.flatMap(record => {
    const payloadHash = contentHash(record), prior = byId.get(record.sourceRecordId);
    if (prior && BigInt(prior.modified_ms) === BigInt(record.sourceModifiedTimeMs) && prior.payload_hash !== payloadHash) {
      throw new ApiError(409, 'source_version_conflict');
    }
    if (prior && BigInt(prior.modified_ms) >= BigInt(record.sourceModifiedTimeMs)) return [];
    return [{ id: record.sourceRecordId, modified: record.sourceModifiedTimeMs, hash: payloadHash,
      start: (BigInt(record.startTimeMs) * 1000000n).toString(),
      finish: (BigInt(record.endTimeMs) * 1000000n).toString(), payload: record }];
  });
  if (rows.length) await sql.query(`INSERT INTO health_bridge.trainingcamp_activities
      (owner_id,source_id,source_record_id,modified_ms,payload_hash,start_ns,end_ns,payload)
    SELECT $1,$2,x.id,x.modified,x.hash,x.start,x.finish,x.payload FROM
      jsonb_to_recordset($3::jsonb) AS x(id text,modified bigint,hash text,start numeric,finish numeric,payload jsonb)
    ON CONFLICT(owner_id,source_id,source_record_id) DO UPDATE SET
      modified_ms=EXCLUDED.modified_ms,payload_hash=EXCLUDED.payload_hash,
      start_ns=EXCLUDED.start_ns,end_ns=EXCLUDED.end_ns,payload=EXCLUDED.payload`,
  [p.owner, p.source, JSON.stringify(rows)]);
  const receipt = { batchId: batch.batchId, source: TRAININGCAMP_SOURCE, committed: true,
    committedAt: new Date().toISOString(), receivedRecords: batch.records.length, changedRecords: rows.length,
    sourceCompleteness: 'unknown', deletionDetection: 'not_available' };
  await sql.query(`INSERT INTO health_bridge.sync_batches(owner_id,source_id,batch_id,request_hash,receipt)
    VALUES($1,$2,$3,$4,$5::jsonb)`, [p.owner, p.source, batch.batchId, requestHash, JSON.stringify(receipt)]);
  return receipt;
}

/** Separate cursor identity prevents accidentally continuing an Android/Health Sync page. */
export type TrainingCampQuery = Query & { snapshot?: string; sleepStages?: 'paged'; stageOffset?: number };
export function parseTrainingCampQuery(url: URL): TrainingCampQuery {
  if (url.searchParams.get('source') !== TRAININGCAMP_SOURCE) throw new ApiError(400, 'invalid_source');
  if (url.searchParams.has('origin')) throw new ApiError(403, 'origin_not_allowed');
  const base = new URL(url); base.searchParams.delete('cursor');
  const q = parseQuery(base);
  if (!(WEB_READ_TYPES as readonly string[]).includes(q.type)) throw new ApiError(400, 'trainingcamp_type_not_supported');
  const snapshot = url.searchParams.get('snapshot') ?? undefined;
  const sleepStages = url.searchParams.get('sleepStages') ?? undefined;
  if (sleepStages !== undefined && (sleepStages !== 'paged' || q.type !== 'SleepSessionRecord')) {
    throw new ApiError(400, 'sleep_stage_paging_not_supported');
  }
  if (q.type === 'SleepSessionRecord' && !z.uuid().safeParse(snapshot).success) throw new ApiError(400, 'sleep_snapshot_required');
  if (q.type === exerciseType && snapshot !== undefined) throw new ApiError(400, 'snapshot_not_supported');
  // Preserve already-issued activity cursor identity; sleep cursors add snapshot identity.
  const fingerprint = hash(JSON.stringify(sleepStages === 'paged'
    ? [TRAININGCAMP_SOURCE, q.fingerprint, snapshot, 'sleep_stages_paged_v1']
    : snapshot === undefined ? [TRAININGCAMP_SOURCE, q.fingerprint] : [TRAININGCAMP_SOURCE, q.fingerprint, snapshot]));
  let after = '0', stageOffset = 0;
  if (url.searchParams.has('cursor')) {
    try {
      const c = JSON.parse(Buffer.from(url.searchParams.get('cursor')!, 'base64url').toString());
      if (c.f !== fingerprint || !/^\d{1,18}$/.test(c.a)) throw new Error();
      if (sleepStages === 'paged') {
        if (!Number.isSafeInteger(c.o) || c.o < 0 || c.o >= 20000 || (c.o > 0 && c.a === '0')) throw new Error();
        stageOffset = c.o;
      }
      after = c.a;
    } catch { throw new ApiError(400, 'invalid_cursor'); }
  }
  return { ...q, origin: null, fingerprint, after, snapshot,
    ...(sleepStages === 'paged' ? { sleepStages, stageOffset } : {}) };
}

const selection = `owner_id=$1 AND start_ns<$3::numeric AND end_ns>$2::numeric
  AND ($4::numeric IS NULL OR (start_ns>=$4::numeric AND end_ns<=$5::numeric))`;
const params = (p: Principal, q: Query) => [p.owner, ns(q.start).toString(), ns(q.end).toString(),
  q.readWindow ? ns(q.readWindow.start).toString() : null, q.readWindow ? ns(q.readWindow.end).toString() : null];
const sourcePolicy = { requiredSource: TRAININGCAMP_SOURCE, fallbackUsed: false, crossSourceMerge: 'not_performed' };
function requireTrainingCampRead(p: Principal, q: Query) {
  requireScope(p, 'read', exerciseType);
  if (q.type !== exerciseType) throw new ApiError(400, 'trainingcamp_type_not_supported');
  if (q.origin !== null) throw new ApiError(403, 'origin_not_allowed');
}

export async function trainingCampRecords(sql: Sql, p: Principal, q: Query, maxBytes = 180 * 1024) {
  requireTrainingCampRead(p, q);
  const rows = (await sql.query(`SELECT record_key::text,source_id,payload FROM health_bridge.trainingcamp_activities
    WHERE ${selection} AND record_key>$6::bigint ORDER BY trainingcamp_activities.record_key LIMIT $7`,
  [...params(p, q), q.after, q.limit + 1])).rows;
  const records = []; let size = 0, after = q.after;
  for (const row of rows.slice(0, q.limit)) {
    const item = { sourceId: row.source_id, source: TRAININGCAMP_SOURCE, record: row.payload,
      workoutMetrics: trainingCampWorkoutMetrics(row.payload.sourceSummary) };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (size + bytes > maxBytes) {
      if (!records.length) throw new ApiError(413, 'record_exceeds_response_limit');
      break;
    }
    records.push(item); size += bytes; after = row.record_key;
  }
  return { records, nextCursor: rows.length > records.length ? cursor(q, after) : null, sourcePolicy,
    semantics: 'overlap [start,end); retained Training Camp activity fields, original source type codes; live pagination; no cross-source deduplication; workoutMetrics are source-reported per-exercise steps and heart-rate summary only, never daily steps or full-day heart-rate samples' };
}

export async function trainingCampSummary(sql: Sql, p: Principal, q: Query) {
  requireTrainingCampRead(p, q);
  const rows = (await sql.query(`SELECT source_id,count(*)::text AS records_count,
    min(start_ns)::text AS first_ns,max(end_ns)::text AS last_ns FROM health_bridge.trainingcamp_activities
    WHERE ${selection} GROUP BY source_id ORDER BY source_id`, params(p, q))).rows;
  return { bySource: rows.map(row => ({ source_id: row.source_id, source: TRAININGCAMP_SOURCE,
    records_count: row.records_count,
    recordTimeBounds: { earliestStart: instantFromNs(row.first_ns), latestEnd: instantFromNs(row.last_ns) } })),
    sourcePolicy, metrics: 'source record counts and time bounds only; units of raw summaries/activeTime unverified; no derived training load' };
}
