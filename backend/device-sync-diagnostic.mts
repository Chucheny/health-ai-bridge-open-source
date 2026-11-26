// Operator-only metadata diagnostic; never query payloads, sample values or tokens.
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { z } from 'zod';
import { inspectIntegrity } from './integrity.mts';
let database: Database | undefined;
let phase='input';
try {
  let input=''; for await(const chunk of process.stdin){input+=chunk;if(input.length>1024)throw new Error();}
  const p=z.strictObject({ownerId:z.uuid(),sourceId:z.uuid()}).parse(JSON.parse(input));
  if(!process.env.HEALTH_ADMIN_DATABASE_URL)throw new Error();
  database=postgresDatabase(process.env.HEALTH_ADMIN_DATABASE_URL,process.env.HEALTH_DATABASE_CA);
  phase='connect';
  const result=await database.transaction(async sql=>{
    phase='streams';
    const streams=(await sql.query(`SELECT record_type,sequence::text FROM health_bridge.sync_streams WHERE owner_id=$1 AND source_id=$2 ORDER BY record_type`,[p.ownerId,p.sourceId])).rows;
    phase='batches';
    const batches=(await sql.query(`SELECT count(*)::text AS committed_batches,max((receipt->>'operationCount')::int) AS largest_operation_count FROM health_bridge.sync_batches WHERE owner_id=$1 AND source_id=$2`,[p.ownerId,p.sourceId])).rows[0];
    phase='integrity';
    const integrity=process.env.HEALTH_DEVICE_INTEGRITY==='true'?await inspectIntegrity(sql,p.ownerId,p.sourceId):undefined;
    return {streams,...batches,...(integrity?{integrity}:{})};
  });
  console.log(JSON.stringify(result));
}catch(e){const code=typeof e==='object'&&e!==null&&'code'in e?String(e.code):'';
console.error(JSON.stringify({error:'DEVICE_SYNC_METADATA_UNAVAILABLE',phase,...(/^[A-Z0-9_]{5,35}$/.test(code)?{code}:{})}));process.exitCode=1;}
finally{await database?.close?.();}
