import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { CAPACITY_TABLES, TRAININGCAMP_CAPACITY_TABLES, inspectCapacity } from '../capacity.mts';
import { inspectTrainingCampIntegrity } from '../trainingcamp-integrity.mts';
import { contentHash, hash, HEALTH_SYNC_ORIGIN } from '../protocol.mts';
import { ensureRuntimeRole, RUNTIME_ROLE, verifyRuntimeRole } from '../runtime-role.mts';
import { createHandler } from '../api.mts';
import { auditWindow, bindSyntheticDatabase, createSyntheticFixture, migrations, seedSyntheticIdentity,
  syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const tables = [...CAPACITY_TABLES, ...TRAININGCAMP_CAPACITY_TABLES];
async function tableFingerprints(pg: PGlite, names: readonly string[]) {
  const data: Record<string, string> = {};
  for (const table of names) {
    const rows = (await pg.query(`SELECT * FROM health_bridge.${table}`)).rows;
    assert(rows.length > 0, 'every table must participate in the recovery drill');
    data[table] = contentHash(rows.map(contentHash).sort());
  }
  return data;
}
// All comparisons remain in memory. No database directory, dump, token or health JSON is written to disk.
async function fingerprints(pg: PGlite) {
  const data = await tableFingerprints(pg, tables);
  const catalog = (await pg.query(`SELECT c.relname,c.relrowsecurity,c.relacl::text FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='health_bridge' AND c.relkind='r' ORDER BY c.relname`)).rows;
  const constraints = (await pg.query(`SELECT c.relname,con.conname,pg_get_constraintdef(con.oid) AS definition
    FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace
    WHERE n.nspname='health_bridge' ORDER BY c.relname,con.conname`)).rows;
  const policies = (await pg.query(`SELECT tablename,policyname,roles,cmd,qual,with_check FROM pg_policies
    WHERE schemaname='health_bridge' ORDER BY tablename,policyname`)).rows;
  const sequences = (await pg.query(`SELECT sequencename,last_value FROM pg_sequences WHERE schemaname='health_bridge' ORDER BY sequencename`)).rows;
  return { data, catalog: contentHash(catalog), constraints: contentHash(constraints),
    policies: contentHash(policies), sequences };
}

test('populated core database keeps sync and MCP through staged grants, enablement, and switch rollback', async () => {
  const pg = new PGlite();
  const sql = { query: (query: string, params?: unknown[]) => pg.query<any>(query, params) };
  const grantRuntime = () => pg.transaction(tx => ensureRuntimeRole({ query: (q, p) => tx.query<any>(q, p) }, 'a'.repeat(43)));
  async function asRuntime<T>(run: () => Promise<T>) {
    await pg.exec(`SET ROLE ${RUNTIME_ROLE}`);
    try { return await run(); } finally { await pg.exec('RESET ROLE'); }
  }
  async function applyMigration(index: number) {
    await pg.exec(await readFile(new URL('../migrations/' + migrations[index], import.meta.url), 'utf8'));
  }
  const owner = randomUUID();
  const identity = () => ({ owner, source: randomUUID(), token: randomBytes(32).toString('base64url') });
  const phone = identity(), web = identity();
  const original = bindSyntheticDatabase(pg, phone, false);
  const webOff = bindSyntheticDatabase(pg, web, false);
  const metadata = (id: string) => ({ id, dataOriginPackage: HEALTH_SYNC_ORIGIN,
    lastModifiedTime: '2026-01-02T00:00:00.123456789Z', clientRecordVersion: '0', recordingMethod: 0 });
  const heart = { recordType: 'HeartRateRecord', metadata: metadata('synthetic-legacy-heart'),
    startTime: '2026-01-01T01:00:00Z', endTime: '2026-01-01T02:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
    samples: [{ time: '2026-01-01T01:30:00.123456789Z', beatsPerMinute: 67, unit: 'BPM' }] };
  const sleep = { recordType: 'SleepSessionRecord', metadata: metadata('synthetic-legacy-sleep'),
    startTime: '2026-01-01T22:00:00Z', endTime: '2026-01-02T06:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
    stages: [{ startTime: '2026-01-01T22:00:00.123456789Z', endTime: '2026-01-01T23:00:00.987654321Z', stage: 4, stageName: 'synthetic' }] };
  const makeBatch = (record: typeof heart | typeof sleep, sequence = 1) => ({
    schemaVersion: 1, batchId: randomUUID(), recordType: record.recordType, sequence, operations: [{ op: 'upsert', record }],
  });
  const coreBatches = [makeBatch(heart), makeBatch(sleep)];
  const activityBatch = syntheticActivityBatch(), sleepBatch = syntheticSleepBatch();
  const catalog = 'trainingcamp/sleep/snapshots?' + new URLSearchParams(auditWindow);
  const webActivity = { source: 'huawei_trainingcamp', type: 'ExerciseSessionRecord' };
  async function coreRecords(client: typeof original) {
    return Promise.all(coreBatches.map(async ({ recordType }) => {
      const result = await client.call('health_records', { type: recordType });
      assert.notEqual(result.isError, true);
      const page = JSON.parse(result.content[0].text);
      assert.equal(page.availability.requiredOrigin, HEALTH_SYNC_ORIGIN);
      assert.equal(page.availability.fallbackUsed, false);
      return page.records;
    }));
  }
  try {
    await applyMigration(0);
    await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [owner]);
    for (const [device, allowed] of [[phone, ['HeartRateRecord', 'SleepSessionRecord']],
      [web, ['ExerciseSessionRecord', 'SleepSessionRecord']]] as const) {
      const scopes = device === phone ? ['sync', 'read', 'clear'] : ['sync', 'read'];
      await pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
        VALUES($1,$2,$3,$4,$5)`, [hash(device.token), owner, device.source, scopes, allowed]);
    }
    await grantRuntime();
    const baseline = await asRuntime(async () => {
      assert.equal((await verifyRuntimeRole(sql)).rlsTables, 7);
      const receipts = [];
      for (const batch of coreBatches) {
        const result = await original.request('sync', batch);
        assert.equal(result.status, 200);
        receipts.push(result.body);
      }
      const records = await coreRecords(original);
      assert.equal(records[0][0].record.samples[0].time, heart.samples[0].time);
      assert.equal(records[1][0].record.stages[0].endTime, sleep.stages[0].endTime);
      return { receipts, records };
    });
    const oldRows = await tableFingerprints(pg, CAPACITY_TABLES);
    for (const [index, tableCount] of [[1, 8], [2, 10]]) {
      await applyMigration(index);
      await asRuntime(async () => {
        await assert.rejects(verifyRuntimeRole(sql), /Runtime table privileges do not match/);
        assert.deepEqual(await coreRecords(original), baseline.records);
        assert.equal((await webOff.request(catalog)).status, 404);
        const clear = await original.request('data', undefined, 'DELETE', original.api,
          { 'x-confirm-clear': 'delete-all-my-cloud-health-data' });
        assert.deepEqual(clear, { status: 503, body: { error: 'temporarily_unavailable' } });
      });
      await grantRuntime();
      await asRuntime(async () => {
        assert.equal((await verifyRuntimeRole(sql)).rlsTables, tableCount);
        for (const [index, batch] of coreBatches.entries()) {
          assert.deepEqual(await original.request('sync', batch), { status: 200, body: baseline.receipts[index] });
        }
      });
      assert.deepEqual(await tableFingerprints(pg, CAPACITY_TABLES), oldRows);
    }

    const webOn = bindSyntheticDatabase(pg, web);
    await asRuntime(async () => {
      assert.equal((await webOff.request('trainingcamp/import', activityBatch)).status, 404);
      assert.equal((await webOff.request('trainingcamp/sleep/import', sleepBatch)).status, 404);
      const activity = await webOn.request('trainingcamp/import', activityBatch);
      const importedSleep = await webOn.request('trainingcamp/sleep/import', sleepBatch);
      assert.equal(activity.status, 200);
      assert.equal(importedSleep.status, 200);
      assert.equal((await webOn.request(catalog)).body.snapshots[0].snapshotId, importedSleep.body.snapshotId);
      assert.deepEqual(await coreRecords(webOn), baseline.records);

      const rolledBack = bindSyntheticDatabase(pg, phone, false);
      assert.equal((await rolledBack.request(catalog)).status, 404);
      assert.equal((await rolledBack.call('health_records', webActivity)).isError, true);
      assert.deepEqual(await coreRecords(rolledBack), baseline.records);
      const continued = await rolledBack.request('sync', makeBatch({ ...heart, metadata: metadata('synthetic-post-rollback-heart') }, 2));
      assert.equal(continued.status, 200);
      assert.equal(continued.body.sequence, 2);

      const reopened = bindSyntheticDatabase(pg, web);
      assert.deepEqual(await reopened.request('trainingcamp/import', activityBatch), activity);
      assert.deepEqual(await reopened.request('trainingcamp/sleep/import', sleepBatch), importedSleep);
      for (const args of [webActivity, { source: 'huawei_trainingcamp', type: 'SleepSessionRecord', snapshot: importedSleep.body.snapshotId }]) {
        const result = await reopened.call('health_records', args);
        assert.notEqual(result.isError, true);
        assert.equal(JSON.parse(result.content[0].text).availability.requiredSource, 'huawei_trainingcamp');
      }
    });
  } finally { await pg.close(); }
});

test('in-memory backup restores all ten tables, identities, RLS, receipts, nanoseconds and original MCP behavior', async () => {
  const original = await createSyntheticFixture(450); let restored: PGlite | undefined;
  let originalClosed = false;
  try {
    const other = await seedSyntheticIdentity(original.pg);
    const metadata = (id: string) => ({ id, dataOriginPackage: 'nl.appyhapps.healthsync',
      lastModifiedTime: '2026-01-02T00:00:00.123456789Z', clientRecordVersion: '0', recordingMethod: 0 });
    for (const record of [
      { recordType: 'HeartRateRecord', metadata: metadata('synthetic-heart'), startTime: '2026-01-01T01:00:00Z',
        endTime: '2026-01-01T02:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
        samples: [{ time: '2026-01-01T01:30:00.123456789Z', beatsPerMinute: 67, unit: 'BPM' }] },
      { recordType: 'SleepSessionRecord', metadata: metadata('synthetic-hc-sleep'), startTime: '2026-01-01T22:00:00Z',
        endTime: '2026-01-02T06:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
        stages: [{ startTime: '2026-01-01T22:00:00.123456789Z', endTime: '2026-01-01T23:00:00.987654321Z', stage: 4, stageName: 'synthetic' }] },
    ]) {
      const r = await original.request('sync', { schemaVersion: 1, batchId: randomUUID(), recordType: record.recordType,
        sequence: 1, operations: [{ op: 'upsert', record }] }); assert.equal(r.status, 200);
    }
    await ensureRuntimeRole({ query: (q, p) => original.pg.query<any>(q, p) }, 'a'.repeat(43));
    const before = await fingerprints(original.pg);
    const archive = await original.pg.dumpDataDir('gzip'); assert(archive.size > 0);
    await original.pg.close(); originalClosed = true;
    restored = await PGlite.create({ loadDataDir: archive });
    const afterRestore = await fingerprints(restored);
    assert.deepEqual({ ...afterRestore, sequences: undefined }, { ...before, sequences: undefined });
    // Physical recovery can advance sequence reservation positions. It must never go backwards.
    for (let i = 0; i < before.sequences.length; i++) {
      const prior = before.sequences[i] as any, current = afterRestore.sequences[i] as any;
      assert.equal(current.sequencename, prior.sequencename);
      assert(BigInt(current.last_value) >= BigInt(prior.last_value));
    }
    const c = bindSyntheticDatabase(restored, original), second = bindSyntheticDatabase(restored, other);
    const sizes = await inspectCapacity(c.db, undefined, { includeTrainingCamp: true }); assert.equal(sizes.complete, true);
    assert.equal((await inspectTrainingCampIntegrity(c.db, c.scope)).status, 'pass');
    assert.deepEqual((await c.request('trainingcamp/sleep/import', original.sleepBatch)).body, original.sleepReceipt);
    assert.deepEqual((await c.request('trainingcamp/import', original.activityBatch)).body, original.activityReceipt);
    assert.deepEqual(await fingerprints(restored), afterRestore, 'receipt replay must not alter restored rows or identity counters');
    const old = JSON.parse((await c.call('health_records', { type: 'HeartRateRecord' })).content[0].text);
    assert.equal(old.records.length, 1); assert.equal(old.availability.requiredOrigin, 'nl.appyhapps.healthsync');
    assert.equal(old.records[0].record.samples[0].time, '2026-01-01T01:30:00.123456789Z');
    const webArgs = { source: 'huawei_trainingcamp', type: 'SleepSessionRecord', snapshot: original.sleepReceipt.snapshotId, sleepStages: 'paged' };
    const reconstructed: unknown[] = []; let cursor: string | undefined; let pageCount = 0;
    do {
      const result = await c.call('health_records', { ...webArgs, ...(cursor ? { cursor } : {}) }); assert.notEqual(result.isError, true);
      const page = JSON.parse(result.content[0].text);
      for (const item of page.records) if (item.record.sleepKind === 'main_sleep') {
        assert.equal(item.stagePage.startIndex, reconstructed.length); reconstructed.push(...item.record.stages);
      }
      cursor = page.nextCursor ?? undefined; pageCount++; assert(pageCount < 20);
    } while (cursor);
    assert.equal(reconstructed.length, 450);
    const storedStages = (await restored.query<any>(`SELECT payload->'stages' AS stages FROM health_bridge.trainingcamp_sleep_records
      WHERE owner_id=$1 AND ordinal=0`, [c.owner])).rows[0].stages;
    assert.deepEqual(reconstructed, storedStages);
    const forbidden = await second.call('health_records', webArgs);
    assert.equal(forbidden.content[0].text, 'sleep_snapshot_not_found');
    // Restored serials continue above existing records and retain their uniqueness constraints.
    const sequenceTables = ['health_records', 'trainingcamp_activities', 'trainingcamp_sleep_records'];
    const maximums = new Map<string, bigint>();
    for (const table of sequenceTables) maximums.set(table,
      BigInt((await restored.query<any>(`SELECT max(record_key)::text AS key FROM health_bridge.${table}`)).rows[0].key));
    assert.equal((await c.request('trainingcamp/import', syntheticActivityBatch())).status, 200);
    assert.equal((await c.request('trainingcamp/sleep/import', syntheticSleepBatch(1, [2]))).status, 200);
    assert.equal((await c.request('sync', { schemaVersion: 1, batchId: randomUUID(), recordType: 'HeartRateRecord', sequence: 2,
      operations: [{ op: 'upsert', record: { recordType: 'HeartRateRecord', metadata: metadata('synthetic-heart-after-restore'),
        startTime: '2026-01-01T03:00:00Z', endTime: '2026-01-01T04:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00', samples: [] } }] })).status, 200);
    for (const table of sequenceTables) assert(
      BigInt((await restored.query<any>(`SELECT max(record_key)::text AS key FROM health_bridge.${table}`)).rows[0].key) > maximums.get(table)!);
    await restored.exec('SET ROLE health_bridge_runtime');
    await assert.rejects(restored.exec("UPDATE health_bridge.trainingcamp_sleep_records SET payload='{}'::jsonb"));
    assert.equal((await c.request('trainingcamp/import', syntheticActivityBatch())).status, 200);
    const featureOff = createHandler(c.db);
    assert.equal((await c.request('data', undefined, 'DELETE', featureOff,
      { 'x-confirm-clear': 'delete-all-my-cloud-health-data' })).status, 200);
    assert.equal((await c.request('status')).status, 401);
    assert.equal((await restored.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records WHERE owner_id=$1', [c.owner])).rows[0].n, 0);
    assert.equal((await restored.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records WHERE owner_id=$1', [other.owner])).rows[0].n, 3);
    await restored.exec('RESET ROLE');
    await restored.exec(`CREATE ROLE recovery_client; GRANT USAGE ON SCHEMA health_bridge TO recovery_client;
      GRANT SELECT ON ALL TABLES IN SCHEMA health_bridge TO recovery_client; SET ROLE recovery_client`);
    for (const table of tables) assert.equal((await restored.query<any>(`SELECT count(*)::int n FROM health_bridge.${table}`)).rows[0].n, 0);
    await restored.exec('RESET ROLE');
  } finally { if (!originalClosed) await original.pg.close(); await restored?.close(); }
});
