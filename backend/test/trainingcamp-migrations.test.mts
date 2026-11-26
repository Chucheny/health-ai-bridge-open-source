import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../database.mts';
import { hash, HEALTH_SYNC_ORIGIN, TYPES } from '../protocol.mts';
import { ensureRuntimeRole, RUNTIME_ROLE, verifyRuntimeRole } from '../runtime-role.mts';
import { assertTrainingCampMigrationTarget, migrateTrainingCamp } from '../trainingcamp-migrations.mts';
import { bindSyntheticDatabase, migrations, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const password = 'a'.repeat(43);
const adapter = (pg: PGlite): Database => ({
  transaction: run => pg.transaction(tx => run({ query: (q, p) => tx.query<any>(q, p) })),
});
async function apply(pg: PGlite, index: number) {
  await pg.exec(await readFile(new URL('../migrations/' + migrations[index], import.meta.url), 'utf8'));
}

test('unverified authorization rolls back both migrations, then retry and replay preserve legacy data and web receipts', async () => {
  const pg = new PGlite(), admin = adapter(pg);
  const owner = randomUUID(), source = randomUUID(), token = randomBytes(32).toString('base64url');
  const original = bindSyntheticDatabase(pg, { owner, source, token }, false);
  const web = bindSyntheticDatabase(pg, { owner, source, token });
  try {
    await apply(pg, 0);
    await admin.transaction(sql => ensureRuntimeRole(sql, password));
    await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [owner]);
    await pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync','read'],$4)`, [hash(token), owner, source, [...TYPES]]);
    const legacyBatch = {
      schemaVersion: 1, batchId: randomUUID(), recordType: 'StepsRecord', sequence: 1,
      operations: [{ op: 'upsert', record: { recordType: 'StepsRecord',
        metadata: { id: 'synthetic-current-install', dataOriginPackage: HEALTH_SYNC_ORIGIN,
          lastModifiedTime: '2026-01-01T08:00:00Z', clientRecordVersion: '0', recordingMethod: 0 },
        startTime: '2026-01-01T07:00:00Z', endTime: '2026-01-01T08:00:00Z',
        startZoneOffset: '+08:00', endZoneOffset: '+08:00', value: 123, unit: 'steps' } }],
    };
    await pg.exec(`SET ROLE ${RUNTIME_ROLE}`);
    const legacyReceipt = await original.request('sync', legacyBatch);
    assert.equal(legacyReceipt.status, 200);
    await pg.exec('RESET ROLE');

    // An existing policy that no longer matches the reviewed policy makes the final grant check fail.
    await pg.exec('ALTER POLICY bridge_runtime_v1 ON health_bridge.health_records USING (false)');
    await assert.rejects(migrateTrainingCamp(admin, password), /Runtime table privileges do not match/);
    const schema = (await pg.query(`SELECT to_regclass('health_bridge.trainingcamp_activities') AS activity,
      to_regclass('health_bridge.trainingcamp_sleep_snapshots') AS snapshots,
      to_regclass('health_bridge.trainingcamp_sleep_records') AS sessions`)).rows[0];
    assert.deepEqual(schema, { activity: null, snapshots: null, sessions: null });
    const legacyRows = (await pg.query('SELECT count(*)::int AS count FROM health_bridge.health_records')).rows[0];
    assert.deepEqual(legacyRows, { count: 1 });
    await pg.exec('ALTER POLICY bridge_runtime_v1 ON health_bridge.health_records USING (true)');

    assert.deepEqual(await migrateTrainingCamp(admin, password), { appliedMigrations: migrations.slice(1), rlsTables: 10 });
    const activity = syntheticActivityBatch(), sleep = syntheticSleepBatch();
    await pg.exec(`SET ROLE ${RUNTIME_ROLE}`);
    assert.deepEqual(await admin.transaction(verifyRuntimeRole), { leastPrivilege: true, rlsTables: 10 });
    assert.deepEqual(await original.request('sync', legacyBatch), legacyReceipt);
    const webReceipts = [await web.request('trainingcamp/import', activity), await web.request('trainingcamp/sleep/import', sleep)];
    assert(webReceipts.every(receipt => receipt.status === 200));
    await pg.exec('RESET ROLE');

    assert.deepEqual(await migrateTrainingCamp(admin, password), { appliedMigrations: [], rlsTables: 10 });
    await pg.exec(`SET ROLE ${RUNTIME_ROLE}`);
    assert.deepEqual(await web.request('trainingcamp/import', activity), webReceipts[0]);
    assert.deepEqual(await web.request('trainingcamp/sleep/import', sleep), webReceipts[1]);
    assert.deepEqual(await original.request('sync', legacyBatch), legacyReceipt);
  } finally { await pg.close(); }
});

test('migration resumes after 002 and refuses unsupported intermediate states', async () => {
  const pg = new PGlite(), admin = adapter(pg);
  try {
    await apply(pg, 0);
    await admin.transaction(sql => ensureRuntimeRole(sql, password));
    await pg.exec('CREATE VIEW health_bridge.trainingcamp_activities AS SELECT 1 AS fake');
    await assert.rejects(migrateTrainingCamp(admin, password), /Unexpected migration schema/);
    await pg.exec('DROP VIEW health_bridge.trainingcamp_activities');
    await apply(pg, 1);
    assert.deepEqual(await migrateTrainingCamp(admin, password), { appliedMigrations: migrations.slice(2), rlsTables: 10 });
    await pg.exec(`SET ROLE ${RUNTIME_ROLE}`);
    assert.equal((await admin.transaction(verifyRuntimeRole)).rlsTables, 10);
  } finally { await pg.close(); }
});

test('explicit migration rejects different project, host, database and overriding URL options before connecting', () => {
  const admin = 'postgresql://postgres.synthetic:synthetic-password@db.invalid:6543/postgres';
  const runtime = 'postgresql://health_bridge_runtime.synthetic:synthetic-password@db.invalid:6543/postgres';
  assert.doesNotThrow(() => assertTrainingCampMigrationTarget(admin, runtime));
  for (const mismatch of [runtime.replace('.synthetic', '.other'), runtime.replace('db.invalid', 'other.invalid'),
    runtime.replace(':6543', ''), runtime.replace('/postgres', '/other'), runtime + '?host=other.invalid']) {
    assert.throws(() => assertTrainingCampMigrationTarget(admin, mismatch), /same project/);
  }
  const entry = fileURLToPath(new URL('../hosted-bootstrap.mts', import.meta.url));
  const result = spawnSync(process.execPath, [entry, '--apply-trainingcamp-migrations'], { encoding: 'utf8', timeout: 10000,
    env: { ...process.env, HEALTH_ADMIN_DATABASE_URL: admin, HEALTH_RUNTIME_DATABASE_URL: runtime.replace('.synthetic', '.other') } });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, '');
  assert.equal(result.stderr.trim(), 'TRAININGCAMP_MIGRATION_NOT_STARTED');
});
