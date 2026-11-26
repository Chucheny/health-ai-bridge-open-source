// Operator-only pairing. Receives a previously DPAPI-saved config through stdin.
import { z } from 'zod';
import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
import { hash, typeSchema } from './protocol.mts';
const schema = z.strictObject({ schemaVersion:z.literal(1),baseUrl:z.url(),
  ownerId:z.uuid(),sourceId:z.uuid(),token:z.string().regex(/^[A-Za-z0-9_-]{43}$/),allowedTypes:z.array(typeSchema).min(1).max(15) });
let database: Database | undefined;
try {
  const expected = new URL(process.argv[2]);
  if (expected.protocol !== 'https:' || expected.username || expected.password ||
      expected.pathname !== '/' || expected.search || expected.hash) throw new Error();
  let input = ''; for await (const chunk of process.stdin) { input += chunk; if (input.length > 16384) throw new Error(); }
  const config = schema.parse(JSON.parse(input)); input = '';
  if (config.baseUrl !== expected.origin || new Set(config.allowedTypes).size !== config.allowedTypes.length ||
      !process.env.HEALTH_ADMIN_DATABASE_URL) throw new Error();
  database = postgresDatabase(process.env.HEALTH_ADMIN_DATABASE_URL,process.env.HEALTH_DATABASE_CA);
  await database.transaction(async sql => {
    await sql.query('INSERT INTO health_bridge.accounts(id) VALUES($1) ON CONFLICT DO NOTHING',[config.ownerId]);
    const scopes = ['sync','read','revoke','clear'];
    await sql.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,$4,$5) ON CONFLICT DO NOTHING`,[hash(config.token),config.ownerId,config.sourceId,scopes,config.allowedTypes]);
    const row = (await sql.query('SELECT owner_id,source_id,scopes,allowed_types,revoked_at FROM health_bridge.device_tokens WHERE token_hash=$1',[hash(config.token)])).rows[0];
    if (!row || row.owner_id !== config.ownerId || row.source_id !== config.sourceId || row.revoked_at ||
        JSON.stringify(row.scopes) !== JSON.stringify(scopes) || JSON.stringify(row.allowed_types) !== JSON.stringify(config.allowedTypes)) throw new Error();
  });
  const res = await fetch(config.baseUrl+'/api/health/status',{headers:{Authorization:'Bearer '+config.token},redirect:'error',signal:AbortSignal.timeout(30000)});
  if (res.status !== 200 || !res.headers.get('content-type')?.includes('application/json')) throw new Error();
  console.log('DEVICE_CREDENTIAL_REGISTERED_AND_VERIFIED');
} catch { console.error('DEVICE_PAIRING_NOT_VERIFIED'); process.exitCode=1; }
finally { await database?.close?.(); }
