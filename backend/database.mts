import pg from 'pg';
import { ApiError, batchHash, bounds, cursor, hash, HEALTH_SYNC_ORIGIN, instantFromNs, ns } from './protocol.mts';
import type { Batch, HealthRecord, Query, SyncReceiptSelector } from './protocol.mts';
import { canSplitQuery } from './query-errors.mts';

export interface Sql { query(sql: string, params?: any[]): Promise<{ rows: any[] }> }
export interface Database { transaction<T>(fn: (sql: Sql) => Promise<T>): Promise<T>; close?(): Promise<void> }
export function postgresDatabase(connectionString: string, ca?: string): Database {
  const url = new URL(connectionString);
  if (!['postgres:', 'postgresql:'].includes(url.protocol)) throw new Error('Invalid database configuration');
  // pg connection-string SSL options override ssl. Remove them and enforce verified TLS.
  for (const key of ['ssl', 'sslmode', 'sslcert', 'sslkey', 'sslrootcert', 'uselibpqcompat', 'sslnegotiation']) url.searchParams.delete(key);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1,
    ssl: { rejectUnauthorized: true, ...(ca ? { ca } : {}) },
    connectionTimeoutMillis: 10000, idleTimeoutMillis: 10000,
  });
  pool.on('error', () => { /* Never emit raw pg errors, SQL or connection secrets. */ });
  return { async transaction<T>(fn: (sql: Sql) => Promise<T>) {
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '15s'");
      const value = await fn(client);
      await client.query('COMMIT');
      return value;
    } catch (error) { await client.query('ROLLBACK').catch(() => {}); throw error; }
    finally { client.release(); }
  }, close: () => pool.end() };
}
export type Principal = { tokenHash: string; owner: string; source: string; scopes: string[]; types: string[] };
export async function authenticate(sql: Sql, authorization: string | null): Promise<Principal> {
  // 256-bit base64url tokens only. No passwords, JWTs or short tokens accepted here.
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(authorization ?? '')?.[1];
  if (!token) throw new ApiError(401, 'unauthorized');
  const tokenHash = hash(token);
  const initial = (await sql.query('SELECT owner_id FROM health_bridge.device_tokens WHERE token_hash=$1', [tokenHash])).rows[0];
  if (!initial) throw new ApiError(401, 'unauthorized');
  await sql.query('SELECT id FROM health_bridge.accounts WHERE id=$1 FOR UPDATE', [initial.owner_id]);
  // Recheck after owner lock: a clear/revoke may have completed while waiting.
  const row = (await sql.query('SELECT * FROM health_bridge.device_tokens WHERE token_hash=$1 AND revoked_at IS NULL', [tokenHash])).rows[0];
  if (!row) throw new ApiError(401, 'unauthorized');
  return { tokenHash, owner: row.owner_id, source: row.source_id, scopes: row.scopes, types: row.allowed_types };
}
export function requireScope(p: Principal, scope: string, type?: string) {
  if (!p.scopes.includes(scope) || (type && !p.types.includes(type))) throw new ApiError(403, 'forbidden');
}

async function replaceRecords(sql: Sql, p: Principal, records: HealthRecord[]) {
  if (!records.length) return;
  // authenticate() holds the owner's row lock for this transaction, including all
  // chunks. Fetch old state once rather than doing 4-5 remote round trips per record.
  const type = records[0].recordType;
  const oldRows = (await sql.query(`SELECT hc_id,origin,modified_ns,deleted FROM health_bridge.health_records
    WHERE owner_id=$1 AND source_id=$2 AND record_type=$3 AND hc_id=ANY($4::text[])`,
    [p.owner,p.source,type,records.map(r=>r.metadata.id)])).rows;
  const oldById = new Map(oldRows.map(row=>[row.hc_id,row]));
  const current = records.filter(r=>{
    const old=oldById.get(r.metadata.id);
    if(old?.origin && old.origin!==r.metadata.dataOriginPackage) throw new ApiError(409,'origin_conflict');
    return !old?.deleted && (old?.modified_ns==null || BigInt(old.modified_ns)<=ns(r.metadata.lastModifiedTime));
  });
  if(!current.length)return;
  const input=current.map(r=>{ const [start,end]=bounds(r); return {id:r.metadata.id,origin:r.metadata.dataOriginPackage,
    modified_ns:ns(r.metadata.lastModifiedTime).toString(),start_ns:start.toString(),end_ns:end.toString(),
    start_at:'startTime'in r?r.startTime:r.time,payload:r}; });
  const rows=(await sql.query(`INSERT INTO health_bridge.health_records
    (owner_id,source_id,record_type,hc_id,origin,modified_ns,start_ns,end_ns,start_at,payload)
    SELECT $1,$2,$3,x.id,x.origin,x.modified_ns,x.start_ns,x.end_ns,x.start_at,x.payload
    FROM jsonb_to_recordset($4::jsonb) AS x(id text,origin text,modified_ns numeric,start_ns numeric,end_ns numeric,start_at timestamptz,payload jsonb)
    ON CONFLICT (owner_id,source_id,record_type,hc_id) DO UPDATE SET
      origin=EXCLUDED.origin,modified_ns=EXCLUDED.modified_ns,start_ns=EXCLUDED.start_ns,
      end_ns=EXCLUDED.end_ns,start_at=EXCLUDED.start_at,payload=EXCLUDED.payload
    RETURNING hc_id,record_key::text`,[p.owner,p.source,type,JSON.stringify(input)])).rows;
  const keys=new Map<string,string>(rows.map(row=>[row.hc_id,row.record_key]));
  if(keys.size!==current.length)throw new ApiError(503,'temporarily_unavailable');
  await sql.query('DELETE FROM health_bridge.samples WHERE record_key=ANY($1::bigint[])',[[...keys.values()]]);
  await sql.query('DELETE FROM health_bridge.sleep_stages WHERE record_key=ANY($1::bigint[])',[[...keys.values()]]);
  const samples=current.flatMap(r=>'samples'in r?r.samples.map((s,i)=>({key:keys.get(r.metadata.id),i,
    ns:ns(s.time).toString(),time:s.time,value:'beatsPerMinute'in s?s.beatsPerMinute:s.metersPerSecond,
    unit:r.recordType==='HeartRateRecord'?'BPM':'m/s'})):[]);
  if(samples.length)await sql.query(`INSERT INTO health_bridge.samples (record_key,sample_index,time_ns,time_text,value,unit)
    SELECT x.key,x.i,x.ns,x.time,x.value,x.unit FROM
    jsonb_to_recordset($1::jsonb) AS x(key bigint,i int,ns numeric,time text,value double precision,unit text)`,[JSON.stringify(samples)]);
  const stages=current.flatMap(r=>'stages'in r?r.stages.map((s,i)=>({key:keys.get(r.metadata.id),i,
    start:ns(s.startTime).toString(),finish:ns(s.endTime).toString(),stage:s.stage})):[]);
  if(stages.length)await sql.query(`INSERT INTO health_bridge.sleep_stages (record_key,stage_index,start_ns,end_ns,stage)
    SELECT x.key,x.i,x.start,x.finish,x.stage FROM
    jsonb_to_recordset($1::jsonb) AS x(key bigint,i int,start numeric,finish numeric,stage int)`,[JSON.stringify(stages)]);
}
async function deleteRecords(sql: Sql,p: Principal,type: string,ids: string[]){
  const keys=(await sql.query(`INSERT INTO health_bridge.health_records (owner_id,source_id,record_type,hc_id,deleted)
    SELECT $1,$2,$3,id,true FROM unnest($4::text[]) AS id ON CONFLICT(owner_id,source_id,record_type,hc_id)
    DO UPDATE SET deleted=true,payload=NULL RETURNING record_key::text`,[p.owner,p.source,type,[...new Set(ids)]])).rows.map(r=>r.record_key);
  await sql.query('DELETE FROM health_bridge.samples WHERE record_key=ANY($1::bigint[])',[keys]);
  await sql.query('DELETE FROM health_bridge.sleep_stages WHERE record_key=ANY($1::bigint[])',[keys]);
}
async function applyOperations(sql: Sql,p: Principal,batch: Batch){
  let upserts: HealthRecord[]=[], deletes: string[]=[];
  const ids=new Set<string>();
  async function flush(){
    if(upserts.length)await replaceRecords(sql,p,upserts);
    if(deletes.length)await deleteRecords(sql,p,batch.recordType,deletes);
    upserts=[];deletes=[];ids.clear();
  }
  for(const op of batch.operations){
    if(op.op==='upsert'){
      // Duplicate IDs or an operation-kind boundary must observe prior operations
      // in this same transaction (including stale versions and deletion tombstones).
      if(deletes.length || ids.has(op.record.metadata.id))await flush();
      upserts.push(op.record);ids.add(op.record.metadata.id);
    }else{
      if(upserts.length)await flush();
      deletes.push(op.recordId);
    }
  }
  await flush();
}
export async function syncReceipt(sql: Sql, p: Principal, selector: SyncReceiptSelector) {
  requireScope(p, 'sync', selector.recordType);
  const row = (await sql.query(`SELECT receipt - 'recovery' AS receipt FROM health_bridge.sync_batches
    WHERE owner_id=$1 AND source_id=$2 AND batch_id=$3 AND receipt->>'committed'='true'
    AND receipt->>'sequence'=$4 AND receipt->'recovery'->>'recordType'=$5
    AND receipt->'recovery'->>'contentSha256'=$6`,
    [p.owner, p.source, selector.batchId, String(selector.sequence), selector.recordType, selector.contentSha256])).rows[0];
  return row?.receipt ?? null;
}
export async function sync(sql: Sql, p: Principal, batch: Batch, contentSha256?: string) {
  requireScope(p, 'sync', batch.recordType);
  const requestHash = batchHash(batch);
  const old = (await sql.query(`SELECT request_hash,receipt - 'recovery' AS receipt FROM health_bridge.sync_batches
    WHERE owner_id=$1 AND source_id=$2 AND batch_id=$3`, [p.owner, p.source, batch.batchId])).rows[0];
  if (old) {
    if (old.request_hash !== requestHash) throw new ApiError(409, 'batch_content_conflict');
    return old.receipt;
  }
  const stream = (await sql.query(`SELECT sequence FROM health_bridge.sync_streams
    WHERE owner_id=$1 AND source_id=$2 AND record_type=$3`, [p.owner, p.source, batch.recordType])).rows[0];
  if (BigInt(stream?.sequence ?? 0) + 1n !== BigInt(batch.sequence)) throw new ApiError(409, 'sequence_conflict');
  await applyOperations(sql,p,batch);
  const receipt = { batchId: batch.batchId, sequence: batch.sequence, committed: true,
    committedAt: new Date().toISOString(), operationCount: batch.operations.length };
  const storedReceipt = contentSha256
    ? { ...receipt, recovery: { recordType: batch.recordType, contentSha256 } }
    : receipt;
  // authenticate holds the owner lock. Persist the checkpoint and its receipt
  // together so that even an empty Changes page needs fewer database round trips.
  await sql.query(`WITH checkpoint AS (
      INSERT INTO health_bridge.sync_streams (owner_id,source_id,record_type,sequence,committed_at)
      VALUES ($1,$2,$3,$4,$5)
      ON CONFLICT (owner_id,source_id,record_type) DO UPDATE
        SET sequence=EXCLUDED.sequence,committed_at=EXCLUDED.committed_at
      RETURNING owner_id,source_id
    )
    INSERT INTO health_bridge.sync_batches (owner_id,source_id,batch_id,request_hash,receipt)
    SELECT owner_id,source_id,$6,$7,$8::jsonb FROM checkpoint`,
    [p.owner, p.source, batch.recordType, batch.sequence, receipt.committedAt,
      batch.batchId, requestHash, JSON.stringify(storedReceipt)]);
  return receipt;
}
const selection = `r.owner_id=$1 AND r.record_type=$2 AND NOT r.deleted AND
  (r.start_ns < $4::numeric AND (r.end_ns > $3::numeric OR (r.end_ns=r.start_ns AND r.start_ns >= $3::numeric)
    OR (r.record_type IN ('HeartRateRecord','SpeedRecord') AND r.end_ns=$3::numeric)))
  AND ($5::text IS NULL OR r.origin=$5)
  AND ($6::numeric IS NULL OR (r.start_ns >= $6::numeric AND r.start_ns < $7::numeric
    AND r.end_ns <= $7::numeric AND NOT EXISTS (
      SELECT 1 FROM health_bridge.samples authorized_sample WHERE authorized_sample.record_key=r.record_key
        AND authorized_sample.time_ns >= $7::numeric)))`;
function requireOrigin(q: Query) {
  if (q.origin !== null && q.origin !== HEALTH_SYNC_ORIGIN) throw new ApiError(403, 'origin_not_allowed');
}
const params = (p: Principal, q: Query) => [p.owner, q.type, ns(q.start).toString(), ns(q.end).toString(), HEALTH_SYNC_ORIGIN,
  q.readWindow ? ns(q.readWindow.start).toString() : null, q.readWindow ? ns(q.readWindow.end).toString() : null];
export async function records(sql: Sql, p: Principal, q: Query, maxBytes = 3 * 1024 * 1024) {
  requireScope(p, 'read', q.type);
  requireOrigin(q);
  const rows = (await sql.query(`SELECT r.record_key::text,r.source_id,r.payload FROM health_bridge.health_records r
    WHERE ${selection} AND r.record_key>$8::bigint ORDER BY r.record_key LIMIT $9`, [...params(p, q), q.after, q.limit + 1])).rows;
  const items = []; let size = 0; let after = q.after;
  for (const row of rows.slice(0, q.limit)) {
    const item = { sourceId: row.source_id, record: row.payload };
    const bytes = Buffer.byteLength(JSON.stringify(item));
    if (size + bytes > maxBytes) {
      if (!items.length) throw new ApiError(413, 'record_exceeds_response_limit');
      break;
    }
    size += bytes; items.push(item); after = row.record_key;
  }
  return { records: items, nextCursor: rows.length > items.length ? cursor(q, after) : null,
    sourcePolicy: { requiredOrigin: HEALTH_SYNC_ORIGIN, fallbackUsed: false,
      ...(items.length ? {} : { explanation: 'No matching Health Sync records on this page; upstream synchronization and phone permissions are unknown.' }) },
    semantics: 'overlap [start,end); complete original records; live pagination' +
      (q.readWindow ? '; only records fully contained in the authorized window; boundary-crossing records excluded' : '') };
}
export type QueryBudget = { attempts: number; deadline: number };
export async function summary(sql: Sql, p: Principal, q: Query, includeTimeBounds = false,
  budget: QueryBudget = { attempts: 0, deadline: Date.now()+40_000 }) {
  requireScope(p, 'read', q.type);
  requireOrigin(q);
  const sampled = ['HeartRateRecord','SpeedRecord'].includes(q.type);
  const sleep = q.type === 'SleepSessionRecord';
  // Materialize the permitted records once. Child tables are aggregated once,
  // and never touched for unrelated types (the original timeout mechanism).
  const statement = `WITH matching AS MATERIALIZED (
    SELECT r.source_id,r.origin,r.record_key,r.start_ns,r.end_ns,
      ${sampled || sleep || q.type==='ExerciseSessionRecord' ? 'NULL::jsonb' : 'r.payload'} AS payload
    FROM health_bridge.health_records r WHERE ${selection}
      AND ($8::numeric IS NULL OR r.start_ns >= $8::numeric) AND r.start_ns < $9::numeric
    ) ${sampled ? `, sample_totals AS MATERIALIZED (
      SELECT s.record_key,count(*) AS sample_count,min(s.time_ns) AS first_ns,max(s.time_ns) AS last_ns,
        sum(s.value::numeric) AS value_sum,min(s.value) AS value_min,max(s.value) AS value_max
      FROM health_bridge.samples s JOIN matching m ON m.record_key=s.record_key
      WHERE s.time_ns >= $3::numeric AND s.time_ns < $4::numeric GROUP BY s.record_key
    )` : ''} ${sleep ? `, stage_totals AS MATERIALIZED (
      SELECT s.record_key,count(*) AS stage_count FROM health_bridge.sleep_stages s
      JOIN matching m ON m.record_key=s.record_key
      WHERE s.start_ns < $4::numeric AND s.end_ns > $3::numeric GROUP BY s.record_key
    )` : ''}
    SELECT r.source_id,r.origin,count(*)::text AS record_count,
    ${sampled ? 'COALESCE(sum(samples.sample_count),0)' : '0'}::text AS sample_count,
    ${sleep ? 'COALESCE(sum(stages.stage_count),0)' : '0'}::text AS stage_count,
    CASE WHEN $2='StepsRecord' THEN COALESCE(sum(CASE WHEN r.start_ns >= $3::numeric AND r.end_ns <= $4::numeric
      THEN (r.payload->>'value')::numeric ELSE 0 END),0)::text ELSE NULL END AS contained_steps
    , CASE WHEN $2 IN ('DistanceRecord','ActiveCaloriesBurnedRecord') THEN
      sum(CASE WHEN r.start_ns >= $3::numeric AND r.end_ns <= $4::numeric
        THEN (r.payload->>'value')::numeric ELSE 0 END)::text ELSE NULL END AS contained_value,
    ${sampled ? `COALESCE(sum(samples.sample_count),0)::text AS measurement_count,
      COALESCE(sum(samples.value_sum),0)::text AS measurement_sum,
      min(samples.value_min)::text AS measurement_min,max(samples.value_max)::text AS measurement_max` :
      `count(r.payload->>'value')::text AS measurement_count,
      COALESCE(sum((r.payload->>'value')::numeric),0)::text AS measurement_sum,
      min((r.payload->>'value')::numeric)::text AS measurement_min,
      max((r.payload->>'value')::numeric)::text AS measurement_max`}
    ${includeTimeBounds ? `, min(r.start_ns)::text AS first_record_ns, max(r.end_ns)::text AS last_record_ns,
      ${sampled ? 'min(samples.first_ns)' : 'NULL'}::text AS first_sample_ns,
      ${sampled ? 'max(samples.last_ns)' : 'NULL'}::text AS last_sample_ns` : ''}
    FROM matching r ${sampled ? 'LEFT JOIN sample_totals samples USING(record_key)' : ''}
      ${sleep ? 'LEFT JOIN stage_totals stages USING(record_key)' : ''}
    GROUP BY r.source_id,r.origin ORDER BY r.source_id,r.origin`;
  const start = ns(q.start), end = ns(q.end), day = 86400n * 1000000000n;
  let attempts = 0, splits = 0;
  async function window(lo: bigint, hi: bigint): Promise<any[]> {
    attempts++;
    if (++budget.attempts > 96 || Date.now() > budget.deadline) throw new ApiError(503, 'query_retry_budget_exhausted');
    await sql.query('SAVEPOINT health_summary_window');
    try {
      // Each original record belongs to exactly one start-time bucket. All
      // containment/sample tests retain the FULL requested window, including
      // records crossing midnight or a retry boundary. Never prorate steps.
      const rows = (await sql.query(statement, [...params(p,q), lo === start ? null : lo.toString(), hi.toString()])).rows;
      await sql.query('RELEASE SAVEPOINT health_summary_window');
      return rows;
    } catch(error) {
      await sql.query('ROLLBACK TO SAVEPOINT health_summary_window');
      await sql.query('RELEASE SAVEPOINT health_summary_window');
      if (!canSplitQuery(error) || hi-lo <= 60n*1000000000n) throw error;
      splits++;
      const width = hi-lo > day ? day : (hi-lo)/2n;
      const rows: any[] = [];
      for(let a=lo;a<hi;a+=width) rows.push(...await window(a,a+width<hi?a+width:hi));
      return rows;
    }
  }
  const grouped = new Map<string,any>();
  for (const row of await window(start,end)) {
    const key=JSON.stringify([row.source_id,row.origin]), old=grouped.get(key);
    if (!old) { grouped.set(key,row); continue; }
    for(const field of ['record_count','sample_count','stage_count','contained_steps','contained_value','measurement_count','measurement_sum']) {
      if(row[field]!=null)old[field]=addDecimal(old[field]??'0',row[field]);
    }
    for(const field of ['first_record_ns','first_sample_ns','measurement_min']) {
      if(row[field]!=null&&(old[field]==null||lessDecimal(row[field],old[field])))old[field]=row[field];
    }
    for(const field of ['last_record_ns','last_sample_ns','measurement_max']) {
      if(row[field]!=null&&(old[field]==null||lessDecimal(old[field],row[field])))old[field]=row[field];
    }
  }
  const scalarUnits: Record<string,string> = { RestingHeartRateRecord:'BPM',HeartRateVariabilityRmssdRecord:'ms (RMSSD)',
    OxygenSaturationRecord:'%',RespiratoryRateRecord:'breaths/min',WeightRecord:'kg',BloodGlucoseRecord:'mmol/L',BodyTemperatureRecord:'°C',
    HeartRateRecord:'BPM',SpeedRecord:'m/s' };
  const bySource = [...grouped.values()].sort((a,b)=>a.source_id.localeCompare(b.source_id)).map(row=>{
    const { first_record_ns, last_record_ns, first_sample_ns, last_sample_ns,
      measurement_count,measurement_sum,measurement_min,measurement_max,contained_value,...base }=row;
    return {...base,
      ...(q.type==='DistanceRecord'?{contained_distance_m:contained_value}:{}),
      ...(q.type==='ActiveCaloriesBurnedRecord'?{contained_active_calories_kcal:contained_value}:{}),
      ...(scalarUnits[q.type]?{measurement:{count:measurement_count,unit:scalarUnits[q.type],
        minimum:measurement_min==null?null:Number(measurement_min),maximum:measurement_max==null?null:Number(measurement_max),
        mean:measurement_count==='0'?null:Number(measurement_sum)/Number(measurement_count)}}:{}),
      ...(includeTimeBounds?{recordTimeBounds:{earliestStart:instantFromNs(first_record_ns),latestEnd:instantFromNs(last_record_ns)},
        sampleTimeBounds:first_sample_ns==null?null:{earliest:instantFromNs(first_sample_ns),latest:instantFromNs(last_sample_ns)}}:{}),
    };
  });
  return { type: q.type, start: q.start, end: q.end, bySource,
    sourcePolicy: { requiredOrigin: HEALTH_SYNC_ORIGIN, fallbackUsed: false,
      ...(bySource.length ? {} : { explanation: 'No matching Health Sync records; upstream synchronization and phone permissions are unknown. Other origins were not substituted.' }) },
    queryExecution: { attempts, splits, partitionPolicy:'unique record start buckets; full-window containment; no prorating' },
    ...(q.readWindow ? { authorizationPolicy: 'only records fully contained in the authorized window; boundary-crossing records excluded' } : {}),
    stepsPolicy: 'source-separated contained-interval subtotal; never a merged or prorated total', hrvMetric: 'RMSSD only' };
}

// Exact decimal sums for counts, steps and original m/kcal quantities across retries.
function decimalParts(value: string): [bigint,number] {
  const [whole,fraction='']=value.split('.');
  return [BigInt(whole+fraction),fraction.length];
}
function aligned(a:string,b:string):[bigint,bigint,number] {
  const [x,s]=decimalParts(a),[y,t]=decimalParts(b),scale=Math.max(s,t);
  return [x*10n**BigInt(scale-s),y*10n**BigInt(scale-t),scale];
}
function addDecimal(a:string,b:string):string {
  const [x,y,s]=aligned(a,b),value=x+y,sign=value<0n?'-':'',digits=(value<0n?-value:value).toString().padStart(s+1,'0');
  return sign+(s?digits.slice(0,-s)+'.'+digits.slice(-s):digits);
}
function lessDecimal(a:string,b:string):boolean {const [x,y]=aligned(a,b);return x<y;}
