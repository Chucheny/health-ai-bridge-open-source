import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { createHandler } from '../api.mts';
import { hash, ns, TYPES } from '../protocol.mts';
import { inspectIntegrity } from '../integrity.mts';
import type { Database, Sql } from '../database.mts';

// Entirely synthetic fixtures; never read a phone, exported health data or .env.
let pg: PGlite;
let owner: string;
let source: string;
let token: string;
let handler: ReturnType<typeof createHandler>;
let failWrite = false;
let queryCount = 0;
const database: Database = { async transaction<T>(fn: (sql: Sql) => Promise<T>) {
  return pg.transaction(async tx => fn({ async query(sql, values) {
    queryCount++;
    if (failWrite && sql.startsWith('INSERT INTO health_bridge.samples')) throw new Error('synthetic failure');
    return tx.query(sql, values);
  } }));
} };
before(async () => { pg = new PGlite(); await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8')); });
after(async () => { await pg.close(); });
async function setup(scopes = ['sync', 'read', 'revoke', 'clear'], allowed: readonly string[] = TYPES) {
  owner = randomUUID(); source = randomUUID(); token = randomBytes(32).toString('base64url');
  await pg.query('INSERT INTO health_bridge.accounts(id) VALUES ($1)', [owner]);
  await credential(token, owner, source, scopes, allowed);
  handler = createHandler(database);
}
async function credential(value: string, account: string, installation: string, scopes = ['sync','read'], allowed: readonly string[] = TYPES) {
  await pg.query(`INSERT INTO health_bridge.device_tokens (token_hash,owner_id,source_id,scopes,allowed_types)
    VALUES ($1,$2,$3,$4,$5)`, [hash(value), account, installation, scopes, allowed]);
}
function heart(id = randomUUID(), origin = 'nl.appyhapps.healthsync', count = 3): any {
  return { recordType: 'HeartRateRecord', metadata: { id, dataOriginPackage: origin,
    lastModifiedTime: '2026-01-02T00:00:00.123456789Z', clientRecordId: null,
    clientRecordVersion: '9223372036854775807', recordingMethod: 0 },
    startTime: '2026-01-01T00:00:00Z', endTime: '2026-01-01T01:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
    samples: Array.from({ length: count }, (_, i) => ({ time: new Date(Date.UTC(2026,0,1) + i * 250).toISOString(), beatsPerMinute: 60 + i % 40, unit: 'BPM' })) };
}
function batch(record: any, sequence = 1): any {
  return { schemaVersion: 1, batchId: randomUUID(), recordType: record.recordType, sequence,
    operations: [{ op: 'upsert', record }] };
}
async function request(path: string, body?: unknown, auth: string | null = token, method?: string, headers: Record<string,string> = {}) {
  const response = await handler(new Request('https://private.invalid/api/health/' + path, {
    method: method ?? (body === undefined ? 'GET' : 'POST'),
    headers: { ...(auth ? { authorization: 'Bearer ' + auth } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }), ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  }));
  return { status: response.status, body: await response.json() as any, headers: response.headers };
}
const range = (type = 'HeartRateRecord', extra = '') => `?start=2026-01-01T00:00:00Z&end=2026-01-03T00:00:00Z&type=${type}${extra}`;

test('authentication, HTTPS, method and private response headers', async () => {
  await setup();
  assert.equal((await request('status', undefined, null)).status, 401);
  assert.equal((await request('status', undefined, randomBytes(32).toString('base64url'))).status, 401);
  const ok = await request('status');
  assert.equal(ok.status, 200); assert.match(ok.headers.get('cache-control')!, /no-store/);
  assert.equal(ok.headers.get('access-control-allow-origin'), null);
  assert.equal((await handler(new Request('http://private.invalid/api/health/status'))).status, 400);
  assert.equal((await request('status', {}, token)).status, 405);
});
test('SQL persists every synthetic heart point, original metadata and nanoseconds', async () => {
  await setup(); const record = heart(undefined, undefined, 7001); record.samples[1].time = '2026-01-01T00:00:00.000000001Z';
  const upload = await request('sync', batch(record)); assert.equal(upload.status, 200); assert.equal(upload.body.committed, true);
  const out = await request('records' + range()); assert.equal(out.status, 200);
  assert.deepEqual(out.body.records[0].record, record);
  const stored = await pg.query<any>('SELECT * FROM health_bridge.samples WHERE record_key IN (SELECT record_key FROM health_bridge.health_records WHERE owner_id=$1) ORDER BY sample_index', [owner]);
  assert.equal(stored.rows.length, 7001); assert.equal(stored.rows[1].time_ns, ns(record.samples[1].time).toString());
});
test('same batch replay returns identical receipt; changed content conflicts; no duplicate children', async () => {
  await setup(); const b = batch(heart()); const first = await request('sync', b);
  assert.deepEqual((await request('sync', JSON.parse(JSON.stringify(b)))).body, first.body);
  b.operations[0].record.samples[0].beatsPerMinute = 90;
  assert.equal((await request('sync', b)).status, 409);
  assert.equal((await request('summary' + range())).body.bySource[0].sample_count, '3');
  assert.equal((await request('status')).body.streams[0].sequence, '1');
});
test('receipt lookup confirms exact uploaded bytes within the original device scope and leaves records unchanged', async () => {
  await setup(['sync']);
  const submitted = batch(heart());
  const selector = { batchId: submitted.batchId, recordType: submitted.recordType,
    sequence: submitted.sequence, contentSha256: hash(JSON.stringify(submitted)) };
  assert.deepEqual((await request('sync/receipt', selector)).body, { receipt: null });
  const upload = await request('sync', submitted);
  assert.equal(upload.status, 200);
  assert.equal(upload.body.recovery, undefined);
  const found = await request('sync/receipt', selector);
  assert.equal(found.status, 200);
  assert.deepEqual(found.body, { receipt: upload.body });
  assert.match(found.headers.get('cache-control')!, /no-store/);
  assert.deepEqual((await request('sync', submitted)).body, upload.body);
  for (const changed of [{ sequence: 2 }, { recordType: 'StepsRecord' }, { contentSha256: hash('other bytes') }]) {
    assert.deepEqual((await request('sync/receipt', { ...selector, ...changed })).body, { receipt: null });
  }
  const alternate = randomBytes(32).toString('base64url');
  await credential(alternate, owner, randomUUID(), ['sync']);
  assert.deepEqual((await request('sync/receipt', selector, alternate)).body, { receipt: null });
  const reader = randomBytes(32).toString('base64url');
  await credential(reader, owner, source, ['read']);
  assert.equal((await request('sync/receipt', selector, reader)).status, 403);
  const typeRestricted = randomBytes(32).toString('base64url');
  await credential(typeRestricted, owner, source, ['sync'], ['StepsRecord']);
  assert.equal((await request('sync/receipt', selector, typeRestricted)).status, 403);
  assert.equal((await request('sync/receipt', selector, null)).status, 401);
  assert.equal((await request('sync/receipt', { ...selector, authority: owner })).status, 400);
  assert.equal((await request('sync/receipt', { ...selector, extra: 'x'.repeat(512) })).status, 413);
  // Simulate a receipt written before raw-byte proof was added.
  await pg.query("UPDATE health_bridge.sync_batches SET receipt=receipt-'recovery' WHERE owner_id=$1 AND source_id=$2", [owner, source]);
  assert.deepEqual((await request('sync/receipt', selector)).body, { receipt: null });
  assert.deepEqual((await request('sync', submitted)).body, upload.body);
  const records = await pg.query<{ count: number }>(
    'SELECT count(*)::int AS count FROM health_bridge.health_records WHERE owner_id=$1', [owner],
  );
  assert.equal(records.rows[0]?.count, 1);
});
test('page batches commit in order; lost response resumes original batch before next sequence', async () => {
  await setup(); const a = batch(heart()); const b = batch(heart(), 2);
  assert.equal((await request('sync', b)).body.error, 'sequence_conflict');
  assert.equal((await request('sync', a)).status, 200);
  assert.equal((await request('sync', a)).status, 200); // committed, client did not receive reply
  assert.equal((await request('sync', b)).status, 200);
  const page1 = await request('records' + range('HeartRateRecord', '&limit=1'));
  const page2 = await request('records' + range('HeartRateRecord', '&limit=1&cursor=' + page1.body.nextCursor));
  assert.equal(page1.body.records.length, 1); assert.equal(page2.body.records.length, 1);
  assert.notEqual(page1.body.records[0].record.metadata.id, page2.body.records[0].record.metadata.id);
  assert.equal(page2.body.nextCursor, null);
  assert.equal((await request('records' + range('StepsRecord', '&cursor=' + page1.body.nextCursor))).status, 400);
});
test('database failure rolls back records, children, sequence and receipt; identical retry succeeds', async () => {
  await setup(); const b = batch(heart()); failWrite = true;
  try { assert.equal((await request('sync', b)).status, 503); } finally { failWrite = false; }
  assert.equal((await request('records' + range())).body.records.length, 0);
  assert.equal((await request('status')).body.streams.length, 0);
  assert.equal((await request('sync', b)).status, 200);
});
test('updates replace sample arrays; stale update cannot overwrite; delete by HC ID retains tombstone', async () => {
  await setup(); const r = heart(); await request('sync', batch(r));
  const newer = structuredClone(r); newer.metadata.lastModifiedTime = '2026-01-03T00:00:00Z'; newer.samples.pop();
  await request('sync', batch(newer, 2)); await request('sync', batch(r, 3));
  assert.equal((await request('summary' + range())).body.bySource[0].sample_count, '2');
  const d = { schemaVersion: 1, batchId: randomUUID(), recordType: 'HeartRateRecord', sequence: 4,
    operations: [{ op: 'delete', recordId: r.metadata.id }] };
  assert.equal((await request('sync', d)).status, 200);
  assert.equal((await request('records' + range())).body.records.length, 0);
  assert.equal((await request('sync', batch(r, 5))).status, 200);
  assert.equal((await request('records' + range())).body.records.length, 0);
  const tombstone = (await pg.query<any>('SELECT * FROM health_bridge.health_records WHERE owner_id=$1', [owner])).rows[0];
  assert.equal(tombstone.origin, r.metadata.dataOriginPackage); assert.equal(tombstone.deleted, true);
});
test('sleep preserves all original unknown stages, offsets and exact boundaries', async () => {
  await setup(); const r: any = { ...heart(), recordType: 'SleepSessionRecord', title: null, notes: null,
    stages: [{ startTime: '2026-01-01T08:00:00.000000001+08:00', endTime: '2026-01-01T08:10:00+08:00', stage: 42, stageName: '未知（42）' },
      { startTime: '2026-01-01T00:10:00Z', endTime: '2026-01-01T00:20:00Z', stage: 4, stageName: '深睡' }] };
  delete r.samples;
  assert.equal((await request('sync', batch(r))).status, 200);
  assert.deepEqual((await request('records' + range('SleepSessionRecord'))).body.records[0].record, r);
  assert.equal((await request('summary' + range('SleepSessionRecord'))).body.bySource[0].stage_count, '2');
});
test('step queries strictly filter DataOrigin; other uploaded history remains and partial intervals are never prorated', async () => {
  await setup(); const r: any = { ...heart(), recordType: 'StepsRecord', value: 100, unit: 'steps' }; delete r.samples;
  const other = structuredClone(r); other.metadata.id = randomUUID(); other.metadata.dataOriginPackage = 'synthetic.phone';
  const b = batch(r); b.operations.push({ op: 'upsert', record: other }); await request('sync', b);
  const s = (await request('summary' + range('StepsRecord'))).body;
  assert.equal(s.bySource.length, 1); assert.deepEqual(s.bySource.map((x: any) => x.contained_steps), ['100']);
  assert.equal((await pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.health_records WHERE owner_id=$1',[owner])).rows[0].n,2);
  assert.equal((await request('records'+range('StepsRecord','&origin=synthetic.phone'))).body.error,'origin_not_allowed');
  assert.equal('totalSteps' in s, false);
  const partial = await request('summary?start=2026-01-01T00:30:00Z&end=2026-01-01T01:00:00Z&type=StepsRecord');
  assert.deepEqual(partial.body.bySource.map((x: any) => x.contained_steps), ['0']);
});
test('same ID on different installations is preserved, other owners are isolated', async () => {
  await setup(); const r = heart(); await request('sync', batch(r));
  const t2 = randomBytes(32).toString('base64url'); await credential(t2, owner, randomUUID());
  assert.equal((await request('sync', batch(r), t2)).status, 200);
  assert.equal((await request('records' + range())).body.records.length, 2);
  await setup(); assert.equal((await request('records' + range())).body.records.length, 0);
});
test('scope and per-type consent enforce upload and query allowlists', async () => {
  await setup(['read'], ['SleepSessionRecord']);
  assert.equal((await request('sync', batch(heart()))).status, 403);
  assert.equal((await request('records' + range())).status, 403);
  assert.equal((await request('records' + range('SleepSessionRecord'))).status, 200);
});
test('invalid schema, HRV mislabelling, GPS and out-of-bound samples are rejected without raw error', async () => {
  await setup(); const r = heart(); r.samples[0].time = '2025-12-31T23:59:59Z';
  assert.equal((await request('sync', batch(r))).body.error, 'sample_outside_record');
  const gps = heart(); gps.latitude = 1; assert.equal((await request('sync', batch(gps))).body.error, 'invalid_batch');
  const bad=heart(); bad.metadata.clientRecordVersion='SYNTHETIC_SECRET_NEVER_ECHO';
  const diagnostics:string[][]=[];
  handler=createHandler(database,fields=>diagnostics.push(fields));
  const diagnostic=await request('sync',batch(bad));
  assert(diagnostic.body.validationFields.includes('operations.*.record.metadata.clientRecordVersion'));
  assert(!JSON.stringify(diagnostic.body).includes('SYNTHETIC_SECRET_NEVER_ECHO'));
  assert.deepEqual(diagnostics,[diagnostic.body.validationFields]);
  assert(!JSON.stringify(diagnostics).includes('SYNTHETIC_SECRET_NEVER_ECHO'));
  const hrv: any = { ...heart(), recordType: 'HeartRateVariabilityRmssdRecord', time: '2026-01-01T00:00:00Z', zoneOffset: null, value: 42, unit: 'ms (SDNN)' };
  for (const key of ['samples','startTime','endTime','startZoneOffset','endZoneOffset']) delete hrv[key];
  assert.equal((await request('sync', batch(hrv))).body.error, 'invalid_batch');
  hrv.unit = 'ms (RMSSD)'; assert.equal((await request('sync', batch(hrv))).status, 200);
  const oversized = batch(heart()); oversized.operations = Array.from({length: 101}, () => oversized.operations[0]);
  assert.equal((await request('sync', oversized)).status, 400);
});
test('SDK signed Long client versions retain their strings, hashes and replay receipts', async () => {
  await setup();
  let sequence=1;
  for (const version of ['-9223372036854775808','-1','0','9223372036854775807']) {
    const record:any={recordType:'StepsRecord',metadata:{...heart().metadata,clientRecordVersion:version},
      startTime:'2026-01-01T00:00:00.123456789Z',endTime:'2026-01-01T00:01:00.123456789Z',
      startZoneOffset:null,endZoneOffset:null,value:42,unit:'steps'};
    const pending=batch(record,sequence++);
    const first=await request('sync',pending);
    assert.equal(first.status,200);
    assert.deepEqual((await request('sync',pending)).body,first.body);
    const changed=structuredClone(pending);
    changed.operations[0].record.metadata.clientRecordVersion=version==='0'?'1':'0';
    assert.equal((await request('sync',changed)).status,409);
    const saved=await request('records'+range('StepsRecord'));
    assert.deepEqual(saved.body.records.find((r:any)=>r.record.metadata.id===record.metadata.id).record,record);
  }
  for (const invalid of ['-9223372036854775809','9223372036854775808','1.5','1e3','+1','secret',-1,1]) {
    const record=heart();record.metadata.clientRecordVersion=invalid;
    assert.equal((await request('sync',batch(record))).status,400);
  }
});

test('timezone equivalence and nanosecond half-open boundaries; record-end sample is retained', async () => {
  await setup(); const r = heart(); r.endTime = r.startTime;
  r.samples = [{ time: r.startTime, beatsPerMinute: 80, unit: 'BPM' }];
  assert.equal((await request('sync', batch(r))).status, 200);
  assert.equal(ns('2026-01-01T08:00:00.123456789+08:00'), ns('2026-01-01T00:00:00.123456789Z'));
  let s = await request('summary?start=2026-01-01T00:00:00Z&end=2026-01-01T00:00:00.000000001Z&type=HeartRateRecord');
  assert.equal(s.body.bySource[0].sample_count, '1');
  s = await request('summary?start=2025-12-31T23:59:59Z&end=2026-01-01T00:00:00Z&type=HeartRateRecord');
  assert.equal(s.body.bySource.length, 0);
  const end = heart(); end.samples = [{ time: end.endTime, beatsPerMinute: 70, unit: 'BPM' }];
  await request('sync', batch(end, 2));
  s = await request('summary?start=2026-01-01T01:00:00Z&end=2026-01-01T02:00:00Z&type=HeartRateRecord');
  assert.equal(s.body.bySource[0].sample_count, '1');
});
test('revocation blocks replay; clear requires confirmation and revokes every owner credential', async () => {
  await setup(); const b = batch(heart()); await request('sync', b);
  assert.equal((await request('data', undefined, token, 'DELETE')).status, 400);
  const t2 = randomBytes(32).toString('base64url'); await credential(t2, owner, randomUUID());
  assert.equal((await request('data', undefined, token, 'DELETE', { 'x-confirm-clear': 'delete-all-my-cloud-health-data' })).status, 200);
  assert.equal((await request('sync', b)).status, 401);
  assert.equal((await request('status', undefined, t2)).status, 401);
  assert.equal((await pg.query<any>('SELECT count(*)::text AS n FROM health_bridge.health_records WHERE owner_id=$1', [owner])).rows[0].n, '0');
  await setup(); assert.equal((await request('revoke', undefined, token, 'POST')).status, 200);
  assert.equal((await request('status')).status, 401);
});

test('all fifteen existing serializer shapes are accepted without unit conversions', async () => {
  await setup();
  for (const type of TYPES) {
    const r: any = { ...heart(), recordType: type };
    if (type === 'HeartRateRecord') { /* original synthetic heart shape */ }
    else if (type === 'SpeedRecord') r.samples = [{ time: r.startTime, metersPerSecond: 1.25 }];
    else {
      delete r.samples;
      if (type === 'SleepSessionRecord') Object.assign(r, { title: null, notes: null, stages: [] });
      else if (type === 'ExerciseSessionRecord') Object.assign(r, { title: null, notes: null, exerciseType: 56, segments: [], laps: [] });
      else if (['DistanceRecord','ActiveCaloriesBurnedRecord','StepsRecord'].includes(type)) {
        Object.assign(r, { value: 12, unit: ({ DistanceRecord: 'm', ActiveCaloriesBurnedRecord: 'kcal', StepsRecord: 'steps' } as any)[type] });
      } else {
        for (const key of ['startTime','endTime','startZoneOffset','endZoneOffset']) delete r[key];
        Object.assign(r, { time: '2026-01-01T00:00:00.123456789Z', zoneOffset: null });
        const units: Record<string,string> = { RestingHeartRateRecord: 'BPM', HeartRateVariabilityRmssdRecord: 'ms (RMSSD)',
          OxygenSaturationRecord: '%', RespiratoryRateRecord: 'breaths/min', WeightRecord: 'kg', BloodGlucoseRecord: 'mmol/L', BodyTemperatureRecord: '°C' };
        if (type === 'BloodPressureRecord') Object.assign(r, { systolic: 120, diastolic: 80, unit: 'mmHg', bodyPosition: 0, measurementLocation: 0 });
        else Object.assign(r, { value: type === 'RestingHeartRateRecord' ? 60 : 12, unit: units[type] });
        if (type === 'BloodGlucoseRecord') Object.assign(r, { specimenSource: 0, mealType: 0, relationToMeal: 0 });
        if (type === 'BodyTemperatureRecord') r.measurementLocation = 0;
      }
    }
    const result = await request('sync', batch(r));
    assert.equal(result.status, 200, type);
    assert.deepEqual((await request('records' + range(type))).body.records[0].record, r, type);
  }
});

test('duplicate sample timestamps remain independent points; oversized requests fail visibly', async () => {
  await setup(); const r = heart(); r.samples[1].time = r.samples[0].time;
  assert.equal((await request('sync', batch(r))).status, 200);
  assert.equal((await request('summary' + range())).body.bySource[0].sample_count, '3');
  const response = await request('sync', { data: 'x'.repeat(2 * 1024 * 1024) });
  assert.equal(response.status, 413); assert.deepEqual(response.body, { error: 'batch_too_large' });
});

test('100 distinct records and their samples commit with a bounded number of remote database calls', async () => {
  await setup();
  const originals=Array.from({length:100},()=>heart());
  const b=batch(originals[0]);b.operations=originals.map(record=>({op:'upsert',record}));
  queryCount=0;
  assert.equal((await request('sync',b)).status,200);
  assert(queryCount<=20,'one batch must not incur hundreds of cross-region SQL round trips');
  const actual=(await request('records'+range()+'&limit=100')).body.records.map((x:any)=>x.record);
  assert.equal(actual.length,100);
  const byId=new Map(actual.map((x:any)=>[x.metadata.id,x]));
  for(const r of originals)assert.deepEqual(byId.get(r.metadata.id),r);
  assert.equal((await request('summary'+range())).body.bySource[0].sample_count,'300');
  const deletion={...batch(heart(),2),operations:originals.map(record=>({op:'delete',recordId:record.metadata.id}))};
  queryCount=0;
  assert.equal((await request('sync',deletion)).status,200);
  assert(queryCount<=20,'bulk deletions must also have a bounded number of calls');
  assert.equal((await request('records'+range())).body.records.length,0);
  assert.equal((await pg.query<any>('SELECT count(*)::text AS n FROM health_bridge.samples s JOIN health_bridge.health_records r USING(record_key) WHERE owner_id=$1',[owner])).rows[0].n,'0');
});

test('bulk groups preserve repeated IDs, stale versions, mixed deletions and tombstones in original order', async () => {
  await setup();
  const original=heart(), newer={...original,metadata:{...original.metadata,lastModifiedTime:'2026-01-03T00:00:00Z'},samples:original.samples.slice(0,2)};
  const stale={...original,metadata:{...original.metadata,lastModifiedTime:'2026-01-01T00:00:00Z'}};
  const b=batch(original);b.operations=[original,newer,stale].map(record=>({op:'upsert',record}));
  assert.equal((await request('sync',b)).status,200);
  assert.deepEqual((await request('records'+range())).body.records[0].record,newer);
  const other=heart();
  const second={...batch(original,2),operations:[{op:'delete',recordId:original.metadata.id},{op:'delete',recordId:original.metadata.id},
    {op:'upsert',record:newer},{op:'upsert',record:other},{op:'delete',recordId:other.metadata.id}]};
  assert.equal((await request('sync',second)).status,200);
  assert.equal((await request('records'+range())).body.records.length,0);
});

test('an origin conflict in a later bulk group rolls back every earlier operation and receipt', async () => {
  await setup();const original=heart();await request('sync',batch(original));
  const fresh=heart(),conflict={...original,metadata:{...original.metadata,dataOriginPackage:'synthetic.different'}};
  const b={...batch(original,2),operations:[{op:'upsert',record:fresh},{op:'delete',recordId:fresh.metadata.id},{op:'upsert',record:conflict}]};
  assert.equal((await request('sync',b)).body.error,'origin_conflict');
  assert.deepEqual((await request('records'+range())).body.records.map((x:any)=>x.record),[original]);
  assert.equal((await request('status')).body.streams[0].sequence,'1');
});

test('private integrity audit detects missing samples, changed times, stage boundaries and source metadata', async () => {
  await setup();const r=heart();r.samples[0].time='2026-01-01T00:00:00.123456789Z';
  await request('sync',batch(r));
  const sleep={...heart(),recordType:'SleepSessionRecord',title:null,notes:null,
    stages:[{startTime:'2026-01-01T00:00:00.123456789Z',endTime:'2026-01-01T00:30:00.987654321Z',stage:99,stageName:'UNKNOWN'}]};
  delete (sleep as any).samples;
  assert.equal((await request('sync',batch(sleep))).status,200);
  const sql={query:async(s:string,p?:any[])=>pg.query<any>(s,p)};
  const clean=await inspectIntegrity(sql,owner,source);
  assert(Object.values(clean).every(Boolean));
  await pg.query("UPDATE health_bridge.samples SET time_text='2026-01-01T00:00:00Z' WHERE sample_index=0 AND record_key=(SELECT record_key FROM health_bridge.health_records WHERE owner_id=$1 AND record_type='HeartRateRecord')",[owner]);
  assert.equal((await inspectIntegrity(sql,owner,source)).samplesExact,false);
  await pg.query("DELETE FROM health_bridge.samples WHERE sample_index=1 AND record_key=(SELECT record_key FROM health_bridge.health_records WHERE owner_id=$1 AND record_type='HeartRateRecord')",[owner]);
  assert.equal((await inspectIntegrity(sql,owner,source)).sampleCountExact,false);
  await pg.query("UPDATE health_bridge.sleep_stages SET end_ns=end_ns+1 WHERE record_key=(SELECT record_key FROM health_bridge.health_records WHERE owner_id=$1 AND record_type='SleepSessionRecord')",[owner]);
  assert.equal((await inspectIntegrity(sql,owner,source)).stagesExact,false);
  await pg.query("UPDATE health_bridge.health_records SET origin='synthetic.wrong' WHERE owner_id=$1",[owner]);
  assert.equal((await inspectIntegrity(sql,owner,source)).recordMetadataExact,false);
});

test('RLS denies a client role even if schema and table SELECT are accidentally granted', async () => {
  await setup(); await request('sync', batch(heart()));
  await pg.exec(`CREATE ROLE synthetic_untrusted NOLOGIN;
    GRANT USAGE ON SCHEMA health_bridge TO synthetic_untrusted;
    GRANT SELECT ON ALL TABLES IN SCHEMA health_bridge TO synthetic_untrusted;`);
  try {
    await pg.exec('SET ROLE synthetic_untrusted');
    for (const table of ['accounts','device_tokens','sync_streams','sync_batches','health_records','samples','sleep_stages']) {
      const result = await pg.query<any>(`SELECT count(*)::text AS n FROM health_bridge.${table}`);
      assert.equal(result.rows[0].n, '0', table);
    }
  } finally { await pg.exec('RESET ROLE'); }
});
