// Operator-only scoped audit. Payloads stay in memory; reports never include values, IDs or hashes.
import { z } from 'zod';
import type { Database } from './database.mts';
import { contentHash, instantFromNs, ns } from './protocol.mts';
import { TRAININGCAMP_CAPACITY_TABLES } from './capacity.mts';
import { parseTrainingCampImport } from './trainingcamp-store.mts';
import { verifyTrainingCampSleepCapture } from './trainingcamp-capture.mts';

const scopeSchema = z.strictObject({ ownerId: z.uuid(), sourceId: z.uuid(),
  start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) });
export type TrainingCampIntegrityScope = z.infer<typeof scopeSchema>;
export type TrainingCampIntegrityReport = {
  schemaVersion: 1; readOnly: true; scopeApplied: true;
  status: 'pass' | 'fail' | 'no_data' | 'incomplete';
  reason: 'completed' | 'missing_tables' | 'byte_budget' | 'row_budget' | 'time_budget';
  complete: boolean; hasData: boolean;
  missingTables: string[];
  checks: { activityMetadataExact: boolean | null; activityPayloadHashExact: boolean | null;
    sleepAssociationAndOrderExact: boolean | null; sleepSessionsAndStagesExact: boolean | null;
    sleepSnapshotHashExact: boolean | null };
};
class Budget extends Error {
  reason: 'byte_budget' | 'row_budget' | 'time_budget';
  constructor(reason: Budget['reason']) { super('audit_incomplete'); this.reason = reason; }
}
const digits = (value: unknown) => typeof value === 'string' && /^\d{1,30}$/.test(value);

function checkActivity(row: any, payload: any, scope: TrainingCampIntegrityScope) {
  try {
    const normalized = parseTrainingCampImport({ schemaVersion: 1,
      batchId: '00000000-0000-4000-8000-000000000001', source: 'huawei_trainingcamp',
      requestedWindow: { start: scope.start, end: scope.end }, records: [{ id: payload.sourceRecordId,
        activityType: payload.sourceType, startTime: payload.startTimeMs, endTime: payload.endTimeMs,
        modifyTime: payload.sourceModifiedTimeMs, timeZone: payload.sourceTimeZone,
        activeTime: payload.rawActiveTime ?? undefined, activitySummary: payload.sourceSummary ?? undefined }] }).records[0];
    return contentHash(normalized) === contentHash(payload) && row.source_record_id === payload.sourceRecordId &&
      row.modified_ms === payload.sourceModifiedTimeMs && digits(row.start_ns) && digits(row.end_ns) &&
      BigInt(row.start_ns) === BigInt(payload.startTimeMs) * 1000000n && BigInt(row.end_ns) === BigInt(payload.endTimeMs) * 1000000n;
  } catch { return false; }
}
function checkSleep(row: any, payload: any, window: { start: string; end: string }) {
  try {
    if (!digits(row.start_ns) || !digits(row.end_ns) || row.start_ns !== payload.rawStartTime || row.end_ns !== payload.rawEndTime ||
        !['not_provided', 'provided_empty', 'provided_points'].includes(payload.stageDataState) || !Array.isArray(payload.stages)) return false;
    const record = { id: payload.sourceRecordId ?? undefined, startTime: payload.rawStartTime, endTime: payload.rawEndTime,
      dataTypeName: payload.sourceDataType ?? undefined, originalDataCollectorId: payload.sourceCollectorId ?? undefined,
      timeZone: payload.sourceTimeZone, value: payload.fields,
      ...(payload.stageDataState === 'not_provided' ? {} : { subData: { 'com.huawei.continuous.sleep.fragment': {
        samplePoints: payload.stages.map((stage: any) => ({ startTime: stage.startTimeNs, endTime: stage.endTimeNs,
          dataTypeName: stage.sourceDataType ?? undefined, originalDataCollectorId: stage.sourceCollectorId ?? undefined, value: stage.fields })),
      } } }) };
    const result = verifyTrainingCampSleepCapture({ schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'sleep',
      requestedWindow: window, apiRequest: { startTimeNs: ns(window.start).toString(), endTimeNs: (ns(window.end) - 1n).toString() },
      capturedAt: window.end, sourceCompleteness: 'unknown', rawResponse: JSON.stringify({ healthRecords: [record] }) }, window);
    return contentHash(result.records[0]) === contentHash(payload);
  } catch { return false; }
}

export async function inspectTrainingCampIntegrity(database: Database, input: unknown): Promise<TrainingCampIntegrityReport> {
  let scope: TrainingCampIntegrityScope;
  try {
    scope = scopeSchema.parse(input);
    if (ns(scope.start) >= ns(scope.end) || ns(scope.end) - ns(scope.start) > 31n * 86400n * 1000000000n) throw new Error();
  } catch { throw new Error('TRAININGCAMP_INTEGRITY_INPUT_INVALID'); }
  const report: TrainingCampIntegrityReport = { schemaVersion: 1, readOnly: true, scopeApplied: true,
    status: 'incomplete', reason: 'completed', complete: false, hasData: false, missingTables: [],
    checks: { activityMetadataExact: null, activityPayloadHashExact: null, sleepAssociationAndOrderExact: null,
      sleepSessionsAndStagesExact: null, sleepSnapshotHashExact: null } };
  let bytes = 0, rowsRead = 0;
  const deadline = Date.now() + 20000;
  const tick = (cost = 0, rows = 0) => {
    if (Date.now() >= deadline) throw new Budget('time_budget');
    bytes += cost; rowsRead += rows;
    if (!Number.isSafeInteger(bytes) || bytes > 32 * 1024 * 1024) throw new Budget('byte_budget');
    if (rowsRead > 10000) throw new Budget('row_budget');
  };
  try {
    await database.transaction(async sql => {
      await sql.query('SET TRANSACTION ISOLATION LEVEL REPEATABLE READ, READ ONLY');
      await sql.query("SET LOCAL statement_timeout = '5s'");
      await sql.query("SET LOCAL lock_timeout = '2s'");
      const present = (await sql.query(`SELECT c.relname FROM pg_catalog.pg_class c JOIN pg_catalog.pg_namespace n ON n.oid=c.relnamespace
        WHERE n.nspname='health_bridge' AND c.relkind='r' AND c.relname=ANY($1::text[])`, [[...TRAININGCAMP_CAPACITY_TABLES]])).rows;
      report.missingTables = TRAININGCAMP_CAPACITY_TABLES.filter(table => !present.some(r => r.relname === table));
      if (report.missingTables.length) { report.reason = 'missing_tables'; return; }
      report.checks = { activityMetadataExact: true, activityPayloadHashExact: true, sleepAssociationAndOrderExact: true,
        sleepSessionsAndStagesExact: true, sleepSnapshotHashExact: true };
      const bounds = [scope.ownerId, scope.sourceId, ns(scope.start).toString(), ns(scope.end).toString()];
      // Inspect size before reading each payload, so a large row cannot bypass the cumulative budget.
      async function payload(table: 'trainingcamp_activities' | 'trainingcamp_sleep_records', row: any) {
        const cost = Number(row.payload_bytes);
        if (!Number.isSafeInteger(cost) || cost < 0) throw new Error();
        tick(cost, 1);
        const data = (await sql.query(`SELECT payload FROM health_bridge.${table}
          WHERE owner_id=$1 AND source_id=$2 AND record_key=$3::bigint`, [scope.ownerId, scope.sourceId, row.record_key])).rows;
        if (data.length !== 1) throw new Error();
        return data[0].payload;
      }
      let after = '0';
      for (;;) {
        tick();
        const rows = (await sql.query(`SELECT record_key::text,source_record_id,modified_ms::text,payload_hash,
          start_ns::text,end_ns::text,octet_length(payload::text)::text AS payload_bytes FROM health_bridge.trainingcamp_activities
          WHERE owner_id=$1 AND source_id=$2 AND start_ns>=$3::numeric AND end_ns<=$4::numeric
          AND record_key>$5::bigint ORDER BY trainingcamp_activities.record_key LIMIT 100`, [...bounds, after])).rows;
        if (!rows.length) break;
        for (const row of rows) {
          report.hasData = true;
          const data = await payload('trainingcamp_activities', row);
          report.checks.activityMetadataExact &&= checkActivity(row, data, scope);
          report.checks.activityPayloadHashExact &&= row.payload_hash === contentHash(data);
          after = row.record_key;
        }
      }
      let snapshotAfter = '00000000-0000-0000-0000-000000000000';
      for (;;) {
        tick();
        const snapshots = (await sql.query(`SELECT s.snapshot_id,s.content_hash,s.requested_start_ns::text,s.requested_end_ns::text,
          NOT EXISTS(SELECT 1 FROM health_bridge.trainingcamp_sleep_records r WHERE r.snapshot_id=s.snapshot_id
            AND (r.owner_id IS DISTINCT FROM s.owner_id OR r.source_id IS DISTINCT FROM s.source_id)) AS association_exact
          FROM health_bridge.trainingcamp_sleep_snapshots s WHERE s.owner_id=$1 AND s.source_id=$2
          AND s.requested_start_ns>=$3::numeric AND s.requested_end_ns<=$4::numeric
          AND s.snapshot_id>$5::uuid ORDER BY s.snapshot_id LIMIT 100`, [...bounds, snapshotAfter])).rows;
        if (!snapshots.length) break;
        for (const snapshot of snapshots) {
          tick(0, 1); report.hasData = true;
          report.checks.sleepAssociationAndOrderExact &&= snapshot.association_exact === true;
          const window = { start: instantFromNs(snapshot.requested_start_ns), end: instantFromNs(snapshot.requested_end_ns) };
          const records: unknown[] = []; let recordAfter = -1;
          for (;;) {
            tick();
            const rows = (await sql.query(`SELECT record_key::text,ordinal,start_ns::text,end_ns::text,
              octet_length(payload::text)::text AS payload_bytes FROM health_bridge.trainingcamp_sleep_records
              WHERE owner_id=$1 AND source_id=$2 AND snapshot_id=$3 AND ordinal>$4::integer ORDER BY ordinal LIMIT 100`,
            [scope.ownerId, scope.sourceId, snapshot.snapshot_id, recordAfter])).rows;
            if (!rows.length) break;
            for (const row of rows) {
              const data = await payload('trainingcamp_sleep_records', row);
              report.checks.sleepAssociationAndOrderExact &&= row.ordinal === records.length;
              report.checks.sleepSessionsAndStagesExact &&= checkSleep(row, data, window);
              records.push(data); recordAfter = row.ordinal;
            }
          }
          report.checks.sleepSnapshotHashExact &&= snapshot.content_hash === contentHash([
            'trainingcamp_sleep_snapshot_v1', snapshot.requested_start_ns, snapshot.requested_end_ns, records,
          ]);
          snapshotAfter = snapshot.snapshot_id;
        }
      }
      tick(); report.complete = true;
    });
    if (report.complete) report.status = !Object.values(report.checks).every(Boolean) ? 'fail' : report.hasData ? 'pass' : 'no_data';
    return report;
  } catch (error) {
    if (error instanceof Budget || (error && typeof error === 'object' && 'code' in error && ['57014', '55P03'].includes(String(error.code)))) {
      report.complete = false; report.status = 'incomplete'; report.reason = error instanceof Budget ? error.reason : 'time_budget';
      return report;
    }
    throw new Error('TRAININGCAMP_INTEGRITY_UNAVAILABLE');
  }
}
