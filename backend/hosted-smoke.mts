// Operator-only integration check. Fixtures are generated here, never read from a phone/export.
import { randomBytes, randomUUID } from 'node:crypto';
import { isDeepStrictEqual } from 'node:util';
import { writeFile, unlink } from 'node:fs/promises';
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { hash, TYPES } from './protocol.mts';
import { createHandler } from './api.mts';

let admin: Database | undefined, runtime: Database | undefined;
const owners = [randomUUID(), randomUUID()];
const sources = [randomUUID(), randomUUID()];
const ledger = new URL(`../private/cloud/synthetic-run-${owners[0]}.json`, import.meta.url);
const tokens = Array.from({ length: 4 }, () => randomBytes(32).toString('base64url'));
let checked = 0, failure = '', cleanup = false;
let lastHttpStatus: number | undefined, largeBatchMs: number | undefined;
let lastRoute='initialization';
let transportError: string | undefined;
function verify(ok: unknown, label: string) { if (!ok) throw new Error(label); checked++; }
const metadata = (id = randomUUID(), origin = 'nl.appyhapps.healthsync') => ({ id, dataOriginPackage: origin,
  lastModifiedTime: '2026-01-02T00:00:00.123456789Z', clientRecordId: null,
  clientRecordVersion: '9223372036854775807', recordingMethod: 0 });
const span = { startTime: '2026-01-01T08:00:00+08:00', endTime: '2026-01-01T10:00:00+08:00', startZoneOffset: '+08:00', endZoneOffset: '+08:00' };
function batch(type: string, operations: any[], sequence = 1) {
  return { schemaVersion: 1, batchId: randomUUID(), recordType: type, sequence, operations };
}
const upsert = (record: any) => ({ op: 'upsert', record });
const range = (type: string) => '?' + new URLSearchParams({ type, start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' });
try {
  const adminUrl = process.env.HEALTH_ADMIN_DATABASE_URL, runtimeUrl = process.env.HEALTH_RUNTIME_DATABASE_URL;
  if (!adminUrl || !runtimeUrl) throw new Error('configuration_missing');
  const target = process.env.HEALTH_SMOKE_BASE_URL;
  const base = target ? new URL(target) : undefined;
  if (base && (base.protocol !== 'https:' || base.username || base.password ||
      base.pathname !== '/' || base.search || base.hash)) throw new Error('unexpected_target');
  admin = postgresDatabase(adminUrl, process.env.HEALTH_DATABASE_CA);
  runtime = postgresDatabase(runtimeUrl, process.env.HEALTH_DATABASE_CA);
  const localHandler = createHandler(runtime);
  // Non-secret recovery IDs survive a network failure during cleanup.
  await writeFile(ledger, JSON.stringify({ syntheticOnly: true, owners }), { flag: 'wx', mode: 0o600 });
  await admin.transaction(async sql => {
    for (const owner of owners) await sql.query('INSERT INTO health_bridge.accounts(id) VALUES ($1)', [owner]);
    for (let i = 0; i < tokens.length; i++) {
      await sql.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types) VALUES($1,$2,$3,$4,$5)`,
        [hash(tokens[i]), owners[i === 1 ? 1 : 0], sources[i === 1 ? 1 : 0],
          i < 2 ? ['sync','read','revoke','clear'] : i === 2 ? ['read','revoke'] : ['sync','read'], i === 3 ? ['HeartRateRecord'] : TYPES]);
    }
  });
  async function request(path: string, body?: any, token: string | null = tokens[0], method = body ? 'POST' : 'GET', extra: Record<string,string> = {}) {
    lastRoute=path.split('?')[0];
    lastHttpStatus=undefined;
    const req = new Request((base?.origin ?? 'https://bridge.invalid') + '/api/health/' + path, {
      method, headers: { ...(token ? { Authorization: `Bearer ${token}` } : {}), ...(body ? { 'Content-Type': 'application/json' } : {}), ...extra },
      ...(body ? { body: JSON.stringify(body) } : {}), signal: AbortSignal.timeout(45000), redirect: 'error',
    });
    const res = base ? await fetch(req) : await localHandler(req);
    lastHttpStatus = res.status;
    const json = res.headers.get('content-type')?.includes('application/json');
    if (!json) throw new Error('platform_gate_or_non_json_response');
    verify(res.headers.get('cache-control')?.includes('no-store'), 'missing_no_store');
    return { status: res.status, body: await res.json() as any };
  }
  verify((await request('status', undefined, null)).status === 401, 'anonymous_rejected');
  verify((await request('status', undefined, 'a'.repeat(43))).status === 401, 'unknown_token_rejected');
  const heart = { recordType: 'HeartRateRecord', metadata: metadata(), ...span,
    samples: Array.from({ length: 7001 }, (_, i) => ({ time: new Date(Date.UTC(2026,0,1,0,0,i)).toISOString(), beatsPerMinute: 60 + i % 30, unit: 'BPM' })) };
  heart.samples[0].time = '2026-01-01T00:00:00.123456789Z';
  heart.samples[1].time = heart.samples[0].time;
  const hb = batch(heart.recordType, [upsert(heart)]);
  const first = await request('sync', hb);
  verify(first.status === 200 && first.body.committed, 'heart_commit');
  // Deliberately ignore the first acknowledgement and resend the exact persisted batch.
  const replay = await request('sync', hb);
  verify(replay.status === 200 && isDeepStrictEqual(replay.body, first.body), 'lost_ack_idempotency');
  verify((await request('sync', { ...hb, operations: [] })).status === 409, 'batch_conflict');
  verify((await request('sync', batch(heart.recordType, [], 3))).status === 409, 'sequence_gap');
  let data = await request('records' + range(heart.recordType));
  verify(data.status === 200 && isDeepStrictEqual(data.body.records[0]?.record, heart), 'all_heart_samples_and_metadata');
  let totals = await request('summary' + range(heart.recordType));
  verify(totals.status === 200 && totals.body.bySource[0]?.sample_count === '7001', 'heart_count');
  verify((await request('records' + range(heart.recordType), undefined, tokens[1])).body.records.length === 0, 'owner_isolation');
  const sleep = { recordType: 'SleepSessionRecord', metadata: metadata(), ...span, title: null, notes: null,
    stages: [{ startTime: '2026-01-01T08:00:00+08:00', endTime: '2026-01-01T08:20:00.123456789+08:00', stage: 2, stageName: 'LIGHT' },
      { startTime: '2026-01-01T08:20:00.123456789+08:00', endTime: '2026-01-01T10:00:00+08:00', stage: 99, stageName: 'UNKNOWN_99' }] };
  verify((await request('sync', batch(sleep.recordType, [upsert(sleep)]))).status === 200, 'sleep_commit');
  data = await request('records' + range(sleep.recordType));
  verify(isDeepStrictEqual(data.body.records[0]?.record, sleep), 'sleep_boundaries_and_unknown_stage');
  verify((await request('records' + range(sleep.recordType), undefined, tokens[3])).status === 403, 'type_allowlist');
  verify((await request('sync', hb, tokens[2])).status === 403, 'read_only_scope');
  const steps = ['nl.appyhapps.healthsync','nl.appyhapps.healthsync','synthetic.phone.b'].map(origin => ({ recordType: 'StepsRecord', metadata: metadata(undefined,origin), ...span, value: 123, unit: 'steps' }));
  verify((await request('sync', batch('StepsRecord', steps.map(upsert)))).status === 200, 'steps_commit');
  totals = await request('summary' + range('StepsRecord'));
  verify(totals.body.bySource.length === 1 && totals.body.bySource[0].origin === 'nl.appyhapps.healthsync' && totals.body.bySource[0].contained_steps === '246', 'strict_step_origin');
  const page1 = await request('records' + range('StepsRecord') + '&limit=1');
  verify(page1.body.records.length === 1 && typeof page1.body.nextCursor === 'string', 'first_page');
  const page2 = await request('records' + range('StepsRecord') + '&limit=1&cursor=' + encodeURIComponent(page1.body.nextCursor));
  verify(page2.body.records.length === 1 && page2.body.nextCursor === null && page1.body.records[0].record.metadata.id !== page2.body.records[0].record.metadata.id, 'resume_page');
  // Real SDK Long values may carry signed source metadata. Resume the exact
  // request on replay; neither its version strings nor canonical hash may change.
  const signedSteps=['-1','-9223372036854775808'].map(version=>({recordType:'StepsRecord',
    metadata:{...metadata(),clientRecordVersion:version},...span,startZoneOffset:null,endZoneOffset:null,value:42,unit:'steps'}));
  const signedBatch=batch('StepsRecord',signedSteps.map(upsert),2);
  const signedReply=await request('sync',signedBatch);
  verify(signedReply.status===200,'signed_version_commit');
  verify(isDeepStrictEqual((await request('sync',signedBatch)).body,signedReply.body),'signed_version_replay');
  const signedSaved=await request('records'+range('StepsRecord'));
  verify(signedSteps.every(record=>isDeepStrictEqual(signedSaved.body.records.find((r:any)=>r.record.metadata.id===record.metadata.id)?.record,record)),
    'signed_version_exact');
  const hrv = { recordType: 'HeartRateVariabilityRmssdRecord', metadata: metadata(), time: '2026-01-01T00:00:00.123456789Z', zoneOffset: '+08:00', value: 42, unit: 'ms (RMSSD)' };
  verify((await request('sync', batch(hrv.recordType, [upsert({ ...hrv, unit: 'ms (SDNN)' })]))).status === 400, 'sdnn_rejected');
  verify((await request('sync', batch(hrv.recordType, [upsert(hrv)]))).status === 200, 'rmssd_commit');
  const exercise = { recordType: 'ExerciseSessionRecord', metadata: metadata(), ...span, title: null, notes: null, exerciseType: 56,
    segments: [{ startTime: span.startTime, endTime: span.endTime, segmentType: 1, repetitions: 0 }],
    laps: [{ startTime: span.startTime, endTime: span.endTime, lengthMeters: 500 }] };
  verify((await request('sync', batch(exercise.recordType, [upsert(exercise)]))).status === 200, 'exercise_commit');
  verify(isDeepStrictEqual((await request('records' + range(exercise.recordType))).body.records[0]?.record, exercise), 'exercise_children');
  if (process.env.HEALTH_SMOKE_LARGE_BATCH === 'true') {
    const many = Array.from({length:100},()=>upsert({recordType:'WeightRecord',metadata:metadata(),
      time:'2026-01-01T00:00:00.123456789Z',zoneOffset:'+08:00',value:42,unit:'kg'}));
    const started = Date.now();
    try { verify((await request('sync',batch('WeightRecord',many))).status===200,'large_batch_commit'); }
    finally { largeBatchMs=Date.now()-started; }
    verify((await request('summary'+range('WeightRecord'))).body.bySource[0]?.record_count==='100','large_batch_integrity');
  }
  const updated = { ...heart, metadata: { ...heart.metadata, lastModifiedTime: '2026-01-03T00:00:00Z' }, samples: heart.samples.slice(0, 2) };
  verify((await request('sync', batch(heart.recordType, [upsert(updated)], 2))).status === 200, 'update_commit');
  verify((await request('summary' + range(heart.recordType))).body.bySource[0]?.sample_count === '2', 'replace_children');
  verify((await request('sync', batch(heart.recordType, [{ op: 'delete', recordId: heart.metadata.id }], 3))).status === 200, 'deletion_commit');
  verify((await request('records' + range(heart.recordType))).body.records.length === 0, 'deleted_hidden');
  verify((await request('status')).body.streams.find((r: any) => r.record_type === heart.recordType)?.sequence === '3', 'committed_status');
  verify((await request('revoke', undefined, tokens[2], 'POST')).status === 200, 'revoke');
  verify((await request('status', undefined, tokens[2])).status === 401, 'revoked_denied');
  verify((await request('data', undefined, tokens[0], 'DELETE')).status === 400, 'clear_confirmation');
  verify((await request('data', undefined, tokens[0], 'DELETE', { 'x-confirm-clear': 'delete-all-my-cloud-health-data' })).status === 200, 'clear');
  verify((await request('status')).status === 401, 'clear_revokes_all');
  verify((await request('status', undefined, tokens[1])).status === 200, 'clear_preserves_other_owner');
} catch (e) {
  if(e instanceof Error){
    const code=typeof e.cause==='object'&&e.cause!==null&&'code'in e.cause?String(e.cause.code):e.name;
    if(['AbortError','TimeoutError','TypeError','SyntaxError','UND_ERR_SOCKET','UND_ERR_CONNECT_TIMEOUT','ENOTFOUND','ECONNRESET','CERT_HAS_EXPIRED'].includes(code))transportError=code;
  }
  // Only locally authored fixed labels are logged. Never server body, values or raw pg errors.
  const labels = new Set(['configuration_missing','unexpected_target','platform_gate_or_non_json_response',
    'missing_no_store','anonymous_rejected','unknown_token_rejected','heart_commit','lost_ack_idempotency','batch_conflict','sequence_gap',
    'all_heart_samples_and_metadata','heart_count','owner_isolation','sleep_commit','sleep_boundaries_and_unknown_stage','type_allowlist',
    'read_only_scope','steps_commit','strict_step_origin','first_page','resume_page','sdnn_rejected','rmssd_commit','exercise_commit',
    'exercise_children','update_commit','replace_children','deletion_commit','deleted_hidden','committed_status','revoke','revoked_denied',
    'clear_confirmation','clear','clear_revokes_all','clear_preserves_other_owner','large_batch_commit','large_batch_integrity',
    'signed_version_commit','signed_version_replay','signed_version_exact']);
  failure = e instanceof Error && labels.has(e.message) ? e.message : 'connection_or_execution_failed';
  process.exitCode = 1;
} finally {
  if (admin) {
    try {
      await admin.transaction(async sql => {
        // All IDs are fresh for this run. Never clear an existing user's owner/source.
        for (const table of ['health_records','sync_batches','sync_streams','device_tokens']) {
          await sql.query(`DELETE FROM health_bridge.${table} WHERE owner_id=ANY($1::uuid[])`, [owners]);
        }
        await sql.query('DELETE FROM health_bridge.accounts WHERE id=ANY($1::uuid[])', [owners]);
        for (const table of ['health_records','sync_batches','sync_streams','device_tokens']) {
          const r = await sql.query(`SELECT count(*)::text AS n FROM health_bridge.${table} WHERE owner_id=ANY($1::uuid[])`, [owners]);
          if (r.rows[0].n !== '0') throw new Error();
        }
      }); cleanup = true;
      await unlink(ledger).catch(() => {});
    } catch { failure = 'synthetic_cleanup_failed'; process.exitCode = 1; }
  }
  await runtime?.close?.(); await admin?.close?.();
  console.log(JSON.stringify({ mode: process.env.HEALTH_SMOKE_BASE_URL ? 'hosted_https' : 'hosted_runtime_local_handler',
    checksPassed: checked, syntheticCleanup: cleanup, ...(largeBatchMs!==undefined?{largeBatchMs}:{}),
    ...(failure ? { failed: failure,lastHttpStatus,lastRoute,...(transportError?{transportError}:{}) } : { passed: true }) }));
}
