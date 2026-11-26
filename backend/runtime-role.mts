import { createHash, createHmac, pbkdf2Sync, randomBytes } from 'node:crypto';
import type { Sql } from './database.mts';

export const RUNTIME_ROLE = 'health_bridge_runtime';
const marker = 'Health AI Bridge runtime v1';
const tables = ['accounts', 'device_tokens', 'sync_streams', 'sync_batches', 'health_records', 'samples', 'sleep_stages'];
const activityTable = 'trainingcamp_activities';
const sleepTables = ['trainingcamp_sleep_snapshots', 'trainingcamp_sleep_records'];

// PostgreSQL accepts a precomputed verifier: the clear password never enters SQL/logs.
export function scramVerifier(password: string, salt = randomBytes(16)) {
  const salted = pbkdf2Sync(password, salt, 4096, 32, 'sha256');
  const client = createHmac('sha256', salted).update('Client Key').digest();
  const stored = createHash('sha256').update(client).digest('base64');
  const server = createHmac('sha256', salted).update('Server Key').digest('base64');
  salted.fill(0); client.fill(0);
  return `SCRAM-SHA-256$4096:${salt.toString('base64')}$${stored}:${server}`;
}
export async function ensureRuntimeRole(sql: Sql, password: string) {
  if (!/^[A-Za-z0-9_-]{43}$/.test(password)) throw new Error('Invalid generated credential');
  const row = (await sql.query(`SELECT r.oid,r.rolsuper,r.rolcreaterole,r.rolcreatedb,r.rolreplication,r.rolbypassrls,
    r.rolinherit,r.rolcanlogin,shobj_description(r.oid,'pg_authid') AS marker
    FROM pg_roles r WHERE rolname=$1`, [RUNTIME_ROLE])).rows[0];
  if (row && (row.marker !== marker || row.rolsuper || row.rolcreaterole || row.rolcreatedb ||
      row.rolreplication || row.rolbypassrls || row.rolinherit || !row.rolcanlogin)) throw new Error('Unexpected existing role');
  if (row && (await sql.query('SELECT 1 FROM pg_auth_members WHERE member=$1', [row.oid])).rows.length) throw new Error('Unexpected membership');
  if (!row) {
    const verifier = scramVerifier(password);
    // Both identifiers are constants; verifier's alphabet cannot contain SQL quotes.
    await sql.query(`CREATE ROLE ${RUNTIME_ROLE} LOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS PASSWORD '${verifier}'`);
    await sql.query(`COMMENT ON ROLE ${RUNTIME_ROLE} IS '${marker}'`);
  }
  await sql.query(`GRANT CONNECT ON DATABASE postgres TO ${RUNTIME_ROLE}`);
  await sql.query(`GRANT USAGE ON SCHEMA health_bridge TO ${RUNTIME_ROLE}`);
  await sql.query(`GRANT SELECT ON health_bridge.accounts,health_bridge.device_tokens TO ${RUNTIME_ROLE}`);
  // Account row locks require UPDATE privilege; credentials can only be revoked.
  await sql.query(`GRANT UPDATE (id) ON health_bridge.accounts TO ${RUNTIME_ROLE}`);
  await sql.query(`GRANT UPDATE (revoked_at) ON health_bridge.device_tokens TO ${RUNTIME_ROLE}`);
  for (const table of tables.slice(2)) await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON health_bridge.${table} TO ${RUNTIME_ROLE}`);
  await sql.query(`GRANT USAGE ON SEQUENCE health_bridge.health_records_record_key_seq TO ${RUNTIME_ROLE}`);
  for (const table of tables) {
    const existing = (await sql.query(`SELECT 1 FROM pg_policies WHERE schemaname='health_bridge' AND tablename=$1 AND policyname='bridge_runtime_v1'`, [table])).rows;
    if (!existing.length) await sql.query(`CREATE POLICY bridge_runtime_v1 ON health_bridge.${table} TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
  }
  // Optional additive migration: old installations remain usable without the new table.
  // Only this operator tool grants access; deployment does not create policies or roles.
  if ((await sql.query("SELECT to_regclass('health_bridge.trainingcamp_activities') AS relation")).rows[0]?.relation) {
    await sql.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON health_bridge.trainingcamp_activities TO ${RUNTIME_ROLE}`);
    await sql.query(`GRANT USAGE ON SEQUENCE health_bridge.trainingcamp_activities_record_key_seq TO ${RUNTIME_ROLE}`);
    const existing = (await sql.query(`SELECT 1 FROM pg_policies WHERE schemaname='health_bridge'
      AND tablename='trainingcamp_activities' AND policyname='bridge_runtime_v1'`)).rows;
    if (!existing.length) await sql.query(`CREATE POLICY bridge_runtime_v1 ON health_bridge.trainingcamp_activities
      TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
  }
  if ((await sql.query("SELECT to_regclass('health_bridge.trainingcamp_sleep_snapshots') AS relation")).rows[0]?.relation) {
    // Snapshots are immutable: runtime can read, create and clear, but cannot update them.
    for (const table of sleepTables) {
      await sql.query(`GRANT SELECT,INSERT,DELETE ON health_bridge.${table} TO ${RUNTIME_ROLE}`);
      const existing = (await sql.query(`SELECT 1 FROM pg_policies WHERE schemaname='health_bridge'
        AND tablename=$1 AND policyname='bridge_runtime_v1'`, [table])).rows;
      if (!existing.length) await sql.query(`CREATE POLICY bridge_runtime_v1 ON health_bridge.${table}
        TO ${RUNTIME_ROLE} USING (true) WITH CHECK (true)`);
    }
    await sql.query(`GRANT USAGE ON SEQUENCE health_bridge.trainingcamp_sleep_records_record_key_seq TO ${RUNTIME_ROLE}`);
  }
}

// Inspect the named runtime role as either the operator or the runtime itself.
export async function verifyRuntimeGrants(sql: Sql) {
  const identity = (await sql.query(`SELECT rolsuper OR rolbypassrls AS bypasses_rls,
    has_schema_privilege(oid,'health_bridge','CREATE') AS can_create,
    has_column_privilege(oid,'health_bridge.accounts','id','UPDATE') AS can_lock_account,
    has_column_privilege(oid,'health_bridge.device_tokens','revoked_at','UPDATE') AS can_revoke,
    has_column_privilege(oid,'health_bridge.device_tokens','scopes','UPDATE') AS can_change_scopes
    FROM pg_roles WHERE rolname=$1`, [RUNTIME_ROLE])).rows[0];
  if (!identity || identity.bypasses_rls || identity.can_create || !identity.can_lock_account ||
      !identity.can_revoke || identity.can_change_scopes) throw new Error('Runtime identity or column privileges do not match');

  // PostgreSQL treats a comma-separated privilege check as an OR. Check each operation separately.
  const relations = (await sql.query(`SELECT c.relname AS name, c.relrowsecurity AND c.relowner <> to_regrole($1) AS rls,
    EXISTS (SELECT 1 FROM pg_policies p WHERE p.schemaname=n.nspname AND p.tablename=c.relname
      AND p.policyname='bridge_runtime_v1' AND p.roles=ARRAY[$1::name]
      AND p.cmd='ALL' AND p.qual='true' AND p.with_check='true') AS runtime_policy,
    has_table_privilege($1::name,c.oid,'SELECT') AS can_read, has_table_privilege($1::name,c.oid,'INSERT') AS can_insert,
    has_table_privilege($1::name,c.oid,'UPDATE') AS can_update, has_table_privilege($1::name,c.oid,'DELETE') AS can_delete
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='health_bridge' AND c.relkind IN ('r','p')`, [RUNTIME_ROLE])).rows;
  const hasActivity = relations.some(row => row.name === activityTable);
  const hasSleep = relations.some(row => sleepTables.includes(row.name));
  const writable = [...tables.slice(2), ...(hasActivity ? [activityTable] : [])];
  const immutable = hasSleep ? sleepTables : [];
  const expected = [...tables.slice(0, 2), ...writable, ...immutable];
  if ((hasSleep && !hasActivity) || relations.length !== expected.length || !relations.every(row => expected.includes(row.name) &&
      row.rls && row.runtime_policy && row.can_read && row.can_update === writable.includes(row.name) &&
      row.can_insert === (writable.includes(row.name) || immutable.includes(row.name)) &&
      row.can_delete === row.can_insert)) throw new Error('Runtime table privileges do not match');

  const identityTables = ['health_records', ...(hasActivity ? [activityTable] : []), ...(hasSleep ? [sleepTables[1]] : [])];
  const sequenceCheck = (await sql.query(`SELECT bool_and(COALESCE(has_sequence_privilege(
    $2::name, to_regclass(format('health_bridge.%I', name || '_record_key_seq')), 'USAGE'), false)) AS usable
    FROM unnest($1::text[]) AS expected(name)`, [identityTables, RUNTIME_ROLE])).rows[0];
  if (sequenceCheck?.usable !== true) throw new Error('Runtime sequence privileges do not match');
  return { leastPrivilege: true, rlsTables: relations.length };
}

export async function verifyRuntimeRole(sql: Sql) {
  if ((await sql.query('SELECT current_user AS role')).rows[0]?.role !== RUNTIME_ROLE) {
    throw new Error('Runtime identity does not match');
  }
  const result = await verifyRuntimeGrants(sql);
  await sql.query('SELECT 1 FROM health_bridge.health_records LIMIT 1');
  return result;
}
