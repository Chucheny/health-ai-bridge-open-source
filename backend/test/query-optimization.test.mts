import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { records, summary, type Database, type Sql } from '../database.mts';
import { DEFAULT_ANALYSIS_TYPES, HEALTH_SYNC_ORIGIN, ns, parseQuery, TYPES } from '../protocol.mts';
import { createMcpHandler } from '../mcp.mts';
import { parseMcpSettings } from '../mcp-auth.mts';
import { queryFailure } from '../query-errors.mts';

let pg: PGlite;
before(async()=>{pg=new PGlite();await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql',import.meta.url),'utf8'));});
after(async()=>pg.close());
const epoch='2026-10-13T00:00:00+08:00';
const time=(hours:number)=>new Date(Date.parse(epoch)+hours*3600000).toISOString();
async function setup() {
  const owner=randomUUID(),source=randomUUID();
  await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)',[owner]);
  const p={owner,source,tokenHash:'',scopes:['read'],types:[...TYPES]};
  const db:Database={transaction:fn=>pg.transaction(tx=>fn({query:(s,v)=>tx.query<any>(s,v)}))};
  return {owner,source,p,db};
}
function query(type='StepsRecord',hours=720,extra:Record<string,string>={}) {
  return parseQuery(new URL('https://synthetic.invalid/?'+new URLSearchParams({type,start:epoch,end:time(hours),...extra})));
}
async function insert(p:{owner:string;source:string},type:string,id:string,start:string,end:string,payload:any,origin=HEALTH_SYNC_ORIGIN) {
  return (await pg.query<any>(`INSERT INTO health_bridge.health_records
    (owner_id,source_id,record_type,hc_id,origin,start_ns,end_ns,payload)
    VALUES($1,$2,$3,$4,$5,$6,$7,$8) RETURNING record_key`,[p.owner,p.source,type,id,origin,ns(start).toString(),ns(end).toString(),payload])).rows[0].record_key;
}
function handler(db:Database,owner:string) {
  return createMcpHandler(db,parseMcpSettings({resource:'https://synthetic.invalid/mcp',issuer:'https://identity.invalid',
    jwksUrl:'https://identity.invalid/keys',ownerId:owner,subject:'synthetic',clientId:'synthetic',types:[...TYPES]}),async()=>true);
}
async function call(h:ReturnType<typeof handler>,name:string,args:any) {
  const response=await h(new Request('https://synthetic.invalid/mcp',{method:'POST',headers:{authorization:'Bearer synthetic',
    'content-type':'application/json',accept:'application/json, text/event-stream'},body:JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/call',params:{name,arguments:args}})}));
  const result=(await response.json()).result;
  return {result,data:result.isError?undefined:JSON.parse(result.content[0].text)};
}

for(const days of [1,7,14,30])test(`${days}-day steps, distance and calories use contained records and exact units`,async()=>{
  const {p,db}=await setup();
  for(const [type,unit,value] of [['StepsRecord','steps',11384],['DistanceRecord','m',1234.125],['ActiveCaloriesBurnedRecord','kcal',234.25]] as const){
    await pg.query(`INSERT INTO health_bridge.health_records(owner_id,source_id,record_type,hc_id,origin,start_ns,end_ns,payload)
      SELECT $1,$2,$3,'row-'||i,$4,$5::numeric+i*3600000000000::numeric,$5::numeric+(i+1)*3600000000000::numeric,
      jsonb_build_object('recordType',$3::text,'value',$6::numeric,'unit',$7::text) FROM generate_series(0,719) i`,
    [p.owner,p.source,type,HEALTH_SYNC_ORIGIN,ns(epoch).toString(),value,unit]);
    const data=await db.transaction(sql=>summary(sql,p,query(type,days*24),true));
    assert.equal(data.bySource[0].record_count,String(days*24));
    const field=type==='StepsRecord'?'contained_steps':type==='DistanceRecord'?'contained_distance_m':'contained_active_calories_kcal';
    assert.equal(Number(data.bySource[0][field]),value*days*24);
    assert.equal(data.queryExecution.splits,0);
  }
});

test('strict origin wins over misleading manufacturer/model; empty source never falls back; manual types remain readable',async()=>{
  const {p,db}=await setup(),h=handler(db,p.owner);
  await insert(p,'StepsRecord','honor',time(0),time(24),{value:11134,metadata:{device:{manufacturer:'HUAWEI',model:'watch'}}},'com.android.healthconnect.phone.synthetic');
  const empty=await call(h,'health_summary',{type:'StepsRecord',start:epoch,end:time(24)});
  assert.deepEqual(empty.data.bySource,[]);assert.equal(empty.data.availability.status,'no_matching_records');
  assert.equal(empty.data.availability.fallbackUsed,false);
  await insert(p,'StepsRecord','sync',time(0),time(24),{value:11384,metadata:{device:{manufacturer:'HONOR',model:'phone'}}});
  const data=await call(h,'health_summary',{type:'StepsRecord',start:epoch,end:time(24)});
  assert.equal(data.data.bySource.length,1);assert.equal(data.data.bySource[0].contained_steps,'11384');
  assert.equal((await call(h,'health_records',{type:'StepsRecord',start:epoch,end:time(24),origin:'com.android.healthconnect.phone.synthetic'})).result.isError,true);
  assert.equal((await pg.query<any>('SELECT count(*)::int n FROM health_bridge.health_records WHERE owner_id=$1',[p.owner])).rows[0].n,2);
  const queriedTypes:string[]=[];
  const traced:Database={transaction:fn=>db.transaction(sql=>fn({query:async(s,v)=>{
    if(s.startsWith('WITH matching'))queriedTypes.push(v![1]);
    return sql.query(s,v);
  }}))};
  const all=await call(handler(traced,p.owner),'health_summary',{start:epoch,end:time(24)});
  assert.deepEqual(all.data.defaultAnalysisTypes,DEFAULT_ANALYSIS_TYPES);
  assert.deepEqual(queriedTypes,DEFAULT_ANALYSIS_TYPES);
  assert.equal(all.data.summaries.length,10);
  assert(all.data.defaultAnalysisTypes.includes('SpeedRecord'));
  assert(!all.data.defaultAnalysisTypes.includes('WeightRecord'));
  await insert(p,'WeightRecord','manual-weight',time(1),time(1),{value:70,unit:'kg'});
  assert.equal((await call(h,'health_summary',{type:'WeightRecord',start:epoch,end:time(24)})).data.bySource[0].measurement.mean,70);
});

test('summary omits unrelated child aggregates; real sample weighting and RMSSD are preserved',async()=>{
  const {p,db}=await setup();
  for(const type of ['StepsRecord','DistanceRecord','ActiveCaloriesBurnedRecord']){
    await db.transaction(sql=>summary({query:async(s,v)=>{
      if(s.startsWith('WITH matching')){assert(!s.includes('sample_totals'));assert(!s.includes('stage_totals'));assert(!s.includes('LATERAL'));}
      return sql.query(s,v);
    }},p,query(type),true));
  }
  for(const [id,values] of [['a',[60]],['b',[90,90,90]]] as const){
    const key=await insert(p,'HeartRateRecord',id,time(0),time(24),{});
    for(const [i,value] of values.entries())await pg.query('INSERT INTO health_bridge.samples VALUES($1,$2,$3,$4,$5,$6)',[key,i,ns(time(i+1)).toString(),time(i+1),value,'BPM']);
  }
  const data=await db.transaction(sql=>summary(sql,p,query('HeartRateRecord',24),true));
  assert.equal(data.bySource[0].record_count,'2');assert.equal(data.bySource[0].sample_count,'4');
  assert.deepEqual(data.bySource[0].measurement,{count:'4',unit:'BPM',minimum:60,maximum:90,mean:82.5});
  await insert(p,'HeartRateVariabilityRmssdRecord','rmssd',time(1),time(1),{value:42,unit:'ms (RMSSD)'});
  assert.equal((await db.transaction(sql=>summary(sql,p,query('HeartRateVariabilityRmssdRecord'),true))).bySource[0].measurement.unit,'ms (RMSSD)');
});

test('real PostgreSQL aborted statements recover with savepoints, daily/subdaily splits preserve crossing intervals and midnight sleep',async()=>{
  const {p,db}=await setup();
  await insert(p,'StepsRecord','cross-midnight',time(23),time(25),{value:9007199254740991});
  await insert(p,'StepsRecord','cross-start',time(-1),time(1),{value:777});
  await insert(p,'StepsRecord','cross-end',time(47),time(49),{value:888});
  await insert(p,'StepsRecord','end-at-split',time(0),time(24),{value:2});
  await insert(p,'StepsRecord','start-at-split',time(24),time(26),{value:3});
  const key=await insert(p,'SleepSessionRecord','sleep',time(23),time(31),{startTime:time(23),endTime:time(31)});
  await pg.query('INSERT INTO health_bridge.sleep_stages VALUES($1,0,$2,$3,5)',[key,ns(time(23)).toString(),ns(time(31)).toString()]);
  const flaky=(sql:Sql):Sql=>({query:async(s,v)=>{
    if(s.startsWith('WITH matching')&&BigInt(v![8])-BigInt(v![7]??v![2])>12n*3600n*1000000000n)
      return sql.query("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='57014',MESSAGE='SYNTHETIC_SECRET'; END $$");
    return sql.query(s,v);
  }});
  for(const type of ['StepsRecord','SleepSessionRecord']){
    const normal=await db.transaction(sql=>summary(sql,p,query(type,48),true));
    const retried=await db.transaction(sql=>summary(flaky(sql),p,query(type,48),true));
    assert(retried.queryExecution.splits>=3);assert.deepEqual(retried.bySource,normal.bySource);
    if(type==='StepsRecord')assert.equal(retried.bySource[0].contained_steps,'9007199254740996');
    else {assert.equal(retried.bySource[0].record_count,'1');assert.equal(retried.bySource[0].stage_count,'1');}
  }
  const nextDay=await db.transaction(sql=>summary(sql,p,query('SleepSessionRecord',48,{start:time(24)}),true));
  assert.equal(nextDay.bySource[0].record_count,'1');
});

test('retry preserves physiological decimal sums, nanosecond endpoints, timezone offsets and sample boundary points',async()=>{
  const {p,db}=await setup();
  const key=await insert(p,'HeartRateRecord','wide',time(-1),time(25),{});
  const points=[[time(0),60],[time(12),90],[time(24),120]] as const;
  for(const [i,[at,value]] of points.entries())await pg.query('INSERT INTO health_bridge.samples VALUES($1,$2,$3,$4,$5,$6)',[key,i,ns(at).toString(),at,value,'BPM']);
  const base=await db.transaction(sql=>summary(sql,p,query('HeartRateRecord',24),true));
  assert.equal(base.bySource[0].measurement.mean,75);
  assert.equal(base.bySource[0].sample_count,'2');
  const same=await db.transaction(sql=>summary(sql,p,query('HeartRateRecord',24,{start:time(0),end:time(24)}),true));
  assert.deepEqual(same.bySource,base.bySource);
  let fail=true;
  const retried=await db.transaction(sql=>summary({query:async(s,v)=>{
    if(s.startsWith('WITH matching')&&fail){fail=false;return sql.query("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='53200'; END $$");}
    return sql.query(s,v);
  }},p,query('HeartRateRecord',24),true));
  assert.deepEqual(retried.bySource,base.bySource);
});

test('large live pagination makes forward progress; byte-limited pages preserve all records and oversized single records fail',async()=>{
  const {p,db}=await setup(),h=handler(db,p.owner),seen=new Set();
  for(let i=0;i<45;i++)await insert(p,'StepsRecord','page-'+i,time(0),time(1),{id:'page-'+i,value:1,notes:'x'.repeat(20_000)});
  let cursor:string|undefined;
  do{
    const {result,data}=await call(h,'health_records',{type:'StepsRecord',start:epoch,end:time(24),limit:20,...(cursor?{cursor}:{})});
    assert.notEqual(result.isError,true);assert(data.records.length>0);assert(data.records.length<20);
    for(const item of data.records){assert(!seen.has(item.record.id));seen.add(item.record.id);}
    assert(data.nextCursor!==cursor);cursor=data.nextCursor;
  }while(cursor);
  assert.equal(seen.size,45);
  await insert(p,'HeartRateRecord','huge',time(0),time(1),{notes:'x'.repeat(200_000)});
  const huge=await call(h,'health_records',{type:'HeartRateRecord',start:epoch,end:time(24)});
  assert.equal(huge.result.content[0].text,'record_exceeds_response_limit');
  assert.equal(huge.result.structuredContent.error.partialResultsReturned,false);
  const first=await db.transaction(sql=>records(sql,p,query('StepsRecord',24,{limit:'1'})));
  assert(first.nextCursor);
  await assert.rejects(db.transaction(sql=>records(sql,p,query('DistanceRecord',24,{cursor:first.nextCursor!}))),/invalid_cursor/);
});

test('permission/data/internal errors are diagnostic and never retried or returned as zero; resource retry budget fails explicitly',async()=>{
  const {p,db}=await setup();
  for(const code of ['42501','22003','XX000']){
    let calls=0;
    const broken:Database={transaction:fn=>db.transaction(sql=>fn({query:async(s,v)=>{
      if(s.startsWith('WITH matching')){calls++;return sql.query(`DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='${code}',MESSAGE='SYNTHETIC_SECRET'; END $$`);}
      return sql.query(s,v);
    }}))};
    const {result}=await call(handler(broken,p.owner),'health_summary',{type:'StepsRecord',start:epoch,end:time(24)});
    assert.equal(calls,1);assert.equal(result.isError,true);assert.equal(result.structuredContent.error.sqlState,code);
    assert(!JSON.stringify(result).includes('SYNTHETIC_SECRET'));assert(!JSON.stringify(result).includes('query_unavailable'));
    assert.equal(result.structuredContent.error.retryable,false);
  }
  const always:Database={transaction:fn=>db.transaction(sql=>fn({query:async(s,v)=>s.startsWith('WITH matching')?
    sql.query("DO $$ BEGIN RAISE EXCEPTION USING ERRCODE='57014'; END $$"):sql.query(s,v)}))};
  const {result}=await call(handler(always,p.owner),'health_summary',{type:'StepsRecord',start:epoch,end:time(1)});
  assert.equal(result.isError,true);assert.equal(result.structuredContent.error.code,'query_timeout');
  assert.equal(queryFailure(Object.assign(new Error('secret'),{code:'08006'})).code,'database_unavailable');
  await assert.rejects(db.transaction(sql=>summary(sql,p,query(),true,{attempts:96,deadline:Date.now()+1000})),/query_retry_budget_exhausted/);
});
