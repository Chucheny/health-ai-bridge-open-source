import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {PGlite} from '@electric-sql/pglite';
import {inspectSyncObservation,MAX_OBSERVED_RECEIPTS,type SyncObservationScope} from '../sync-observation.mts';
import type {Database} from '../database.mts';

let pg:PGlite;
before(async()=>{pg=new PGlite();await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql',import.meta.url),'utf8'));});
after(async()=>pg.close());
const when=()=>new Date('2026-01-03T00:00:00Z');
const db:Database={transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query<any>(s,v)}))};
async function scope():Promise<SyncObservationScope>{
  const ownerId=randomUUID();await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)',[ownerId]);
  return {ownerId,sourceId:randomUUID(),types:['StepsRecord','SleepSessionRecord'],start:'2026-01-01T00:00:00+08:00',end:'2026-01-03T00:00:00+08:00'};
}
async function receipt(q:SyncObservationScope,at:string,operations:number|string=0,sequence=1,more={}){
  await pg.query(`INSERT INTO health_bridge.sync_batches VALUES($1,$2,$3,$4,$5)`,
    [q.ownerId,q.sourceId,randomUUID(),'a'.repeat(64),{committedAt:at,operationCount:operations,sequence,committed:true,...more}]);
}
async function checkpoint(q:SyncObservationScope,type:string,at:string|null,sequence=1){
  await pg.query('INSERT INTO health_bridge.sync_streams VALUES($1,$2,$3,$4,$5)',[q.ownerId,q.sourceId,type,sequence,at]);
}

test('read-only metadata inspection enforces scope, half-open Beijing days, exact operations and honest background attribution',async()=>{
  const q=await scope();
  await receipt(q,'2025-12-31T15:59:59.999Z',999);
  await receipt(q,'2025-12-31T16:00:00Z',0);
  await receipt(q,'2026-01-01T15:59:59.999Z','9007199254740993',2,{secret:'SYNTHETIC_SECRET'});
  await receipt(q,'2026-01-01T16:00:00Z',2,3);
  await receipt(q,'2026-01-02T16:00:00Z',999,4);
  await receipt({...q,sourceId:randomUUID()},'2026-01-01T16:00:00Z',999);
  const other=await scope();await receipt(other,'2026-01-01T16:00:00Z',999);
  await checkpoint(q,'StepsRecord','2026-01-01T16:00:00Z',3);
  await checkpoint(q,'WeightRecord','2026-01-01T16:00:00Z',3);
  const sqls:string[]=[];
  const traced:Database={transaction:fn=>db.transaction(sql=>fn({query:(s,v)=>{sqls.push(s);return sql.query(s,v);}}))};
  const report=await inspectSyncObservation(traced,q,when);
  assert.equal(report.complete,true);assert.equal(report.observedReceiptCount,3);
  assert.equal(report.operationCount,'9007199254740995');assert.equal(report.emptyReceiptCount,1);
  assert.deepEqual(report.days,[{date:'2026-01-01',receiptCount:2,emptyReceiptCount:1,operationCount:'9007199254740993'},
    {date:'2026-01-02',receiptCount:1,emptyReceiptCount:0,operationCount:'2'}]);
  assert.equal(report.streams.length,1);assert.equal(report.streams[0].receiptEvidence,'matched');
  assert.deepEqual(report.typesWithoutCheckpoint,['SleepSessionRecord']);
  assert.equal(report.backgroundPeriodicAcceptance,'not_verifiable_from_cloud_receipts');
  assert.equal(report.healthPayloadsRead,false);assert.equal(report.phoneStateChecked,false);
  assert(sqls.every(s=>!s.includes('health_bridge.health_records')&&!s.includes('health_bridge.device_tokens')));
  for(const secret of [q.ownerId,q.sourceId,other.ownerId,'SYNTHETIC_SECRET','a'.repeat(64)])assert(!JSON.stringify(report).includes(secret));
});

test('five-minute groups are only heuristics, preserve equal-time batches and never claim complete sync runs',async()=>{
  const q=await scope();
  for(const at of ['2026-01-01T00:00:00Z','2026-01-01T00:05:00Z','2026-01-01T00:05:00Z','2026-01-01T00:10:00.001Z'])await receipt(q,at,1);
  const report=await inspectSyncObservation(db,q,when);
  assert.deepEqual(report.confirmationGroups.map(g=>g.receiptCount),[3,1]);
  assert.equal(report.observedReceiptCount,4);assert.match(report.groupingPolicy,/not identified sync runs/);
});

test('current checkpoints stay independent of historical window; equal sequence/time matches remain ambiguous',async()=>{
  const q=await scope();
  await receipt(q,'2026-01-03T00:00:00Z',0,2);await receipt(q,'2026-01-03T00:00:00Z',0,2);
  await checkpoint(q,'StepsRecord','2026-01-03T00:00:00Z',2);
  await checkpoint(q,'SleepSessionRecord','2026-01-03T00:01:00Z',3);
  const report=await inspectSyncObservation(db,q,when);
  assert.equal(report.status,'no_receipts_in_window');assert.equal(report.firstConfirmation,null);
  assert.equal(report.observedReceiptCount,0);
  assert.deepEqual(report.streams.map(s=>s.receiptEvidence).sort(),['ambiguous','missing']);
  assert.equal(report.existingCheckpointEvidence,'incomplete');
});

test('empty data remains an observation, not a phone/scheduler failure; malformed committed metadata fails visibly',async()=>{
  const q=await scope();const empty=await inspectSyncObservation(db,q,when);
  assert.equal(empty.status,'no_receipts_in_window');assert.equal(empty.existingCheckpointEvidence,'no_checkpoints');
  assert.equal(empty.upstreamFreshness,'unknown');assert.equal(empty.complete,true);
  await receipt(q,'2026-01-01T00:00:00Z',-1);
  await assert.rejects(inspectSyncObservation(db,q,when),/invalid_sync_metadata/);
});

test('receipt ceiling is explicit and never labels a partial earliest slice as complete coverage',async()=>{
  const q=await scope();
  await pg.query(`INSERT INTO health_bridge.sync_batches(owner_id,source_id,batch_id,request_hash,receipt)
    SELECT $1,$2,gen_random_uuid(),repeat('a',64),jsonb_build_object('committedAt','2026-01-01T00:00:00Z',
      'operationCount',0,'sequence',i,'committed',true) FROM generate_series(1,$3) i`,[q.ownerId,q.sourceId,MAX_OBSERVED_RECEIPTS+1]);
  const report=await inspectSyncObservation(db,q,when);
  assert.equal(report.complete,false);assert.equal(report.status,'receipt_limit_reached');
  assert.equal(report.resultScope,'earliest_receipts_only');assert.equal(report.observedReceiptCount,MAX_OBSERVED_RECEIPTS);
});

test('invalid identities/types/ranges and invalid clock fail before connecting to the database',async()=>{
  const q=await scope(),never:Database={transaction:async()=>{throw new Error('DATABASE_MUST_NOT_OPEN');}};
  for(const bad of [{...q,ownerId:'private'}, {...q,types:['unknown']},{...q,types:['StepsRecord','StepsRecord']},
    {...q,end:q.start},{...q,end:'2026-02-02T00:00:00+08:00'},{...q,start:'2026-01-01T00:00:00'},
    {...q,start:'2026-01-01T00:00:00.000000001+08:00'}, {...q,extra:true}])
    await assert.rejects(inspectSyncObservation(never,bad,when),/invalid_observation_input/);
  await assert.rejects(inspectSyncObservation(never,q,()=>new Date(NaN)),/invalid_observation_clock/);
});

test('actual PostgreSQL read-only snapshot denies writes even to a granted sentinel',async()=>{
  const q=await scope();await receipt(q,'2026-01-01T00:00:00Z',1);
  await pg.exec('CREATE TABLE public.sync_observation_probe(id int); INSERT INTO public.sync_observation_probe VALUES(1)');
  const verify:Database={transaction:fn=>pg.transaction(async tx=>{
    const report=await fn({query:(s,v)=>tx.query<any>(s,v)});
    const state=(await tx.query<any>(`SELECT current_setting('transaction_read_only') AS ro,
      current_setting('transaction_isolation') AS isolation,current_setting('statement_timeout') AS timeout,
      current_setting('lock_timeout') AS lock_timeout`)).rows[0];
    assert.deepEqual(state,{ro:'on',isolation:'repeatable read',timeout:'5s',lock_timeout:'2s'});
    await tx.query('SAVEPOINT observation_probe');let error:any;
    try{await tx.query('UPDATE public.sync_observation_probe SET id=2');}catch(e){error=e;}
    await tx.query('ROLLBACK TO SAVEPOINT observation_probe');await tx.query('RELEASE SAVEPOINT observation_probe');
    assert.equal(error?.code,'25006');return report;
  })};
  assert.equal((await inspectSyncObservation(verify,q,when)).readOnly,true);
  assert.deepEqual((await pg.query('SELECT id FROM public.sync_observation_probe')).rows,[{id:1}]);
});

test('diagnostic CLI sanitizes malformed input and database configuration errors without echoes',()=>{
  for(const [input,url] of [['SYNTHETIC_SECRET',''],['{}','postgres://SYNTHETIC_SECRET@private.invalid/postgres']]){
    const p=spawnSync(process.execPath,[fileURLToPath(new URL('../sync-observation-diagnostic.mts',import.meta.url))],
      {encoding:'utf8',input,env:{...process.env,HEALTH_DATABASE_URL:url}});
    assert.equal(p.status,1);const output=p.stdout+p.stderr;
    assert(output.includes('SYNC_OBSERVATION_FAILED'));assert(!output.includes('SYNTHETIC_SECRET'));assert(!output.includes('private.invalid'));
  }
});
