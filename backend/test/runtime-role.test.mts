import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { ensureRuntimeRole, scramVerifier, verifyRuntimeRole } from '../runtime-role.mts';

test('runtime grants allow data operations but prohibit credential issuance/escalation and DDL', async () => {
  const db = new PGlite();
  try {
    await db.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));
    const adapter = { query: async (sql: string, params?: any[]) => db.query<any>(sql, params) };
    const password = 'a'.repeat(43);
    await ensureRuntimeRole(adapter, password);
    await ensureRuntimeRole(adapter, password); // Resume without replacing passwords or policies.
    await db.exec('SET ROLE health_bridge_runtime');
    const privileges = (await db.query<any>(`SELECT
      has_schema_privilege(current_user,'health_bridge','CREATE') AS ddl,
      has_table_privilege(current_user,'health_bridge.device_tokens','INSERT') AS issue,
      has_column_privilege(current_user,'health_bridge.device_tokens','scopes','UPDATE') AS scopes,
      has_column_privilege(current_user,'health_bridge.device_tokens','revoked_at','UPDATE') AS revoke,
      has_table_privilege(current_user,'health_bridge.health_records','SELECT,INSERT,UPDATE,DELETE') AS sync`)).rows[0];
    assert.deepEqual(privileges, { ddl: false, issue: false, scopes: false, revoke: true, sync: true });
    assert.deepEqual(await verifyRuntimeRole(adapter), { leastPrivilege: true, rlsTables: 7 });
    await db.query('SELECT * FROM health_bridge.health_records');
    await assert.rejects(db.exec('CREATE TABLE health_bridge.forbidden(id int)'));
    await assert.rejects(db.exec("UPDATE health_bridge.device_tokens SET scopes=ARRAY['clear']"));
    await assert.rejects(db.exec('INSERT INTO health_bridge.accounts(id) VALUES(gen_random_uuid())'));
    await db.exec('RESET ROLE');
    const policies = await db.query<any>("SELECT * FROM pg_policies WHERE schemaname='health_bridge' AND policyname='bridge_runtime_v1'");
    assert.equal(policies.rows.length, 7);
    await db.exec('REVOKE DELETE ON health_bridge.health_records FROM health_bridge_runtime; SET ROLE health_bridge_runtime');
    await assert.rejects(verifyRuntimeRole(adapter), /Runtime table privileges do not match/);
    await db.exec('RESET ROLE');
    await ensureRuntimeRole(adapter, password);
    await db.exec('REVOKE USAGE ON SEQUENCE health_bridge.health_records_record_key_seq FROM health_bridge_runtime; SET ROLE health_bridge_runtime');
    await assert.rejects(verifyRuntimeRole(adapter), /Runtime sequence privileges do not match/);
  } finally { await db.close(); }
});
test('SCRAM verifier is salted and does not contain clear credentials', () => {
  const password = 'a'.repeat(43);
  const value = scramVerifier(password);
  assert.match(value, /^SCRAM-SHA-256\$4096:[A-Za-z0-9+/=]+\$[A-Za-z0-9+/=]+:[A-Za-z0-9+/=]+$/);
  assert(!value.includes(password));
  assert.notEqual(value, scramVerifier(password));
});
