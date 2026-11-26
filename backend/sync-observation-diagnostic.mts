// Local operator entry point only; do not import into public functions or MCP.
import {postgresDatabase,type Database} from './database.mts';
import {inspectSyncObservation} from './sync-observation.mts';
import {queryFailure} from './query-errors.mts';
let database:Database|undefined;
try {
  let raw='';for await(const chunk of process.stdin){raw+=chunk;if(Buffer.byteLength(raw)>4096)throw new Error();}
  const input=JSON.parse(raw);
  const url=process.env.HEALTH_DATABASE_URL;
  if(!url)throw new Error();
  database=postgresDatabase(url,process.env.HEALTH_DATABASE_CA);
  const report=await inspectSyncObservation(database,input);
  // Close before reporting success so a close failure cannot produce two reports.
  await database.close?.();database=undefined;
  console.log(JSON.stringify(report));
  if(!report.complete||report.existingCheckpointEvidence==='incomplete')process.exitCode=2;
}catch(error){
  console.error(JSON.stringify({error:'SYNC_OBSERVATION_FAILED',diagnostic:queryFailure(error)}));process.exitCode=1;
}finally{await database?.close?.().catch(()=>{});}
