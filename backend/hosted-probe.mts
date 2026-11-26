import { postgresDatabase } from './database.mts';
import type { Database } from './database.mts';
let db: Database | undefined;
try {
  const url = process.env.HEALTH_ADMIN_DATABASE_URL;
  if (!url) throw new Error();
  db = postgresDatabase(url, process.env.HEALTH_DATABASE_CA);
  const result = await db.transaction(async sql => {
    const rows = (await sql.query(`SELECT tablename,rowsecurity FROM pg_catalog.pg_tables
      WHERE schemaname='health_bridge' ORDER BY tablename`)).rows;
    const data = (await sql.query('SELECT count(*)::text AS n FROM health_bridge.health_records WHERE NOT deleted')).rows[0];
    return { tlsConnection: true, tableCount: rows.length, allRlsEnabled: rows.every(r => r.rowsecurity), storedRecordCount: data.n };
  });
  console.log(JSON.stringify(result));
} catch (e) {
  // Fixed codes only; pg errors may include a password, connection string or parameters.
  const code = typeof e === 'object' && e !== null && 'code' in e ? String(e.code) : '';
  const category = code === '28P01' ? 'authentication_failed' :
    ['CERT_HAS_EXPIRED','UNABLE_TO_GET_ISSUER_CERT_LOCALLY','SELF_SIGNED_CERT_IN_CHAIN','DEPTH_ZERO_SELF_SIGNED_CERT'].includes(code)
      ? 'certificate_validation_failed' : ['ENOTFOUND','ETIMEDOUT','ECONNREFUSED'].includes(code) ? 'network_unavailable' : 'connection_failed';
  console.error(JSON.stringify({ error: category, ...(category === 'certificate_validation_failed' ? { code } : {}) })); process.exitCode = 1;
} finally { await db?.close?.(); }
