import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import type { Database } from '../database.mts';
import { CAPACITY_TABLES, inspectCapacity, TRAININGCAMP_CAPACITY_TABLES } from '../capacity.mts';
import { inspectTrainingCampIntegrity } from '../trainingcamp-integrity.mts';
import { createSyntheticFixture, seedSyntheticIdentity } from './support/trainingcamp-fixture.mts';

test('ten-table capacity is explicit, metadata-only and compatible with old or partially migrated databases', async () => {
  const pg = new PGlite();
  const db: Database = { transaction: fn => pg.transaction(tx => fn({ query: (q, p) => tx.query<any>(q, p) })) };
  try {
    await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));
    assert.equal((await inspectCapacity(db)).coverageProfile, 'core');
    assert.equal((await inspectCapacity(db)).complete, true);
    const old = await inspectCapacity(db, undefined, { includeTrainingCamp: true });
    assert.equal(old.complete, false); assert.deepEqual(old.missingTables, [...TRAININGCAMP_CAPACITY_TABLES]);
    await pg.exec(await readFile(new URL('../migrations/002_trainingcamp_activities.sql', import.meta.url), 'utf8'));
    assert.equal((await inspectCapacity(db, undefined, { includeTrainingCamp: true })).missingTables.length, 2);
    await pg.exec(await readFile(new URL('../migrations/003_trainingcamp_sleep.sql', import.meta.url), 'utf8'));
    await pg.exec(`CREATE ROLE ops_size_reader; GRANT USAGE ON SCHEMA health_bridge TO ops_size_reader; SET ROLE ops_size_reader`);
    const full = await inspectCapacity(db, undefined, { includeTrainingCamp: true });
    assert.equal(full.complete, true); assert.equal(full.coverageProfile, 'core_and_trainingcamp'); assert.equal(full.tables.length, 10);
    assert.equal(BigInt(full.selectedTablesBytes), BigInt(full.selectedTableDataBytes) + BigInt(full.selectedIndexBytes));
    assert.equal((await inspectCapacity(db)).tables.length, CAPACITY_TABLES.length);
    await assert.rejects(pg.query('SELECT payload FROM health_bridge.trainingcamp_sleep_records'));
    await pg.exec('RESET ROLE; DROP TABLE health_bridge.trainingcamp_sleep_records; CREATE VIEW health_bridge.trainingcamp_sleep_records AS SELECT 1 AS fake');
    assert.deepEqual((await inspectCapacity(db, undefined, { includeTrainingCamp: true })).missingTables, ['trainingcamp_sleep_records']);
  } finally { await pg.close(); }
});

test('scoped audit uses a genuine read-only snapshot and emits no fixture values, IDs, dates or hashes', async () => {
  const c = await createSyntheticFixture();
  try {
    const before = await c.pg.query('SELECT payload FROM health_bridge.trainingcamp_sleep_records ORDER BY ordinal');
    let readOnly = '';
    const db: Database = { transaction: fn => c.pg.transaction(async tx => {
      const value = await fn({ query: (q, p) => tx.query<any>(q, p) });
      readOnly = (await tx.query<any>("SELECT current_setting('transaction_read_only') AS value")).rows[0].value;
      await tx.exec('SAVEPOINT audit_write_probe'); let error: any;
      try { await tx.query("UPDATE health_bridge.trainingcamp_activities SET payload_hash=payload_hash WHERE owner_id=$1", [c.owner]); }
      catch (e) { error = e; }
      await tx.exec('ROLLBACK TO SAVEPOINT audit_write_probe'); assert.equal(error?.code, '25006');
      return value;
    }) };
    const report = await inspectTrainingCampIntegrity(db, c.scope);
    assert.equal(report.status, 'pass'); assert.equal(report.complete, true); assert.equal(readOnly, 'on');
    assert(Object.values(report.checks).every(v => v === true));
    const text = JSON.stringify(report);
    for (const sentinel of [c.owner, c.source, c.token, 'synthetic-repeated-sleep-id', '1767304800000123456', c.scope.start]) assert(!text.includes(sentinel));
    assert.deepEqual((await c.pg.query('SELECT payload FROM health_bridge.trainingcamp_sleep_records ORDER BY ordinal')).rows, before.rows);
    const other = await seedSyntheticIdentity(c.pg);
    await c.pg.query("UPDATE health_bridge.trainingcamp_activities SET payload_hash=repeat('0',64) WHERE owner_id=$1", [other.owner]);
    assert.equal((await inspectTrainingCampIntegrity(c.db, c.scope)).status, 'pass');
    assert.equal((await inspectTrainingCampIntegrity(c.db, other.scope)).status, 'fail');
    await c.pg.query('UPDATE health_bridge.trainingcamp_activities SET owner_id=$1 WHERE owner_id=$2', [c.owner, other.owner]);
    assert.equal((await inspectTrainingCampIntegrity(c.db, c.scope)).status, 'pass', 'another installation under the same owner stays outside this audit');
    const empty = await inspectTrainingCampIntegrity(c.db, { ...c.scope, start: '2026-01-02T01:00:00Z' });
    assert.equal(empty.status, 'no_data'); assert.equal(empty.hasData, false);
  } finally { await c.pg.close(); }
});

test('audit detects source metadata, payload hashes, sleep classifications, stage precision and missing ordinals', async () => {
    const cases: [string, string][] = [
      ["UPDATE health_bridge.trainingcamp_activities SET modified_ms=modified_ms+1", 'activityMetadataExact'],
      ["UPDATE health_bridge.trainingcamp_activities SET payload_hash=repeat('0',64)", 'activityPayloadHashExact'],
      ["UPDATE health_bridge.trainingcamp_sleep_records SET payload=jsonb_set(payload,'{sleepKind}','\"nap\"') WHERE ordinal=0", 'sleepSessionsAndStagesExact'],
      ["UPDATE health_bridge.trainingcamp_sleep_records SET payload=jsonb_set(payload,'{stages,0,startTimeNs}','\"1767304800000123457\"') WHERE ordinal=0", 'sleepSnapshotHashExact'],
      ["DELETE FROM health_bridge.trainingcamp_sleep_records WHERE ordinal=1", 'sleepAssociationAndOrderExact'],
      ["ALTER TABLE health_bridge.trainingcamp_sleep_records DISABLE TRIGGER ALL; UPDATE health_bridge.trainingcamp_sleep_records SET source_id='00000000-0000-4000-8000-000000000002' WHERE ordinal=0", 'sleepAssociationAndOrderExact'],
      ["UPDATE health_bridge.trainingcamp_sleep_records SET payload=jsonb_set(payload,'{stages,0,endTimeNs}','\"9999999999999999999\"') WHERE ordinal=0", 'sleepSessionsAndStagesExact'],
    ];
    for (const [mutation, key] of cases) {
      const c = await createSyntheticFixture();
      try {
        await c.pg.exec(mutation);
        const report = await inspectTrainingCampIntegrity(c.db, c.scope);
        assert.equal(report.status, 'fail'); assert.equal(report.checks[key as keyof typeof report.checks], false);
      } finally { await c.pg.close(); }
    }
});

test('missing tables, byte/row/time budgets and permissions cannot produce a passing audit', async () => {
  const c = await createSyntheticFixture();
  try {
    const seedPayload = (await c.pg.query<any>('SELECT payload FROM health_bridge.trainingcamp_activities')).rows[0].payload;
    const syntheticDb = (kind: 'bytes' | 'rows' | 'timeout' | 'permissions'): Database => ({ transaction: fn => c.db.transaction(sql => fn({
      async query(q, p) {
        if (kind === 'rows' && q.startsWith('SELECT payload FROM')) return { rows: [{ payload: seedPayload }] };
        if (q.includes('FROM health_bridge.trainingcamp_activities') && q.includes('payload_bytes')) {
          if (kind === 'timeout' || kind === 'permissions') throw Object.assign(new Error('synthetic-private-driver'), { code: kind === 'timeout' ? '57014' : '42501' });
          const rows = (await sql.query(q, p)).rows;
          if (kind === 'bytes') return { rows: rows.map(r => ({ ...r, payload_bytes: String(32 * 1024 * 1024 + 1) })) };
          return { rows: Array.from({ length: 100 }, () => ({ source_record_id: seedPayload.sourceRecordId,
            modified_ms: seedPayload.sourceModifiedTimeMs, payload_hash: '0'.repeat(64), start_ns: '1767229200000000000',
            end_ns: '1767232800000000000', payload_bytes: '1', record_key: '1' })) };
        }
        return sql.query(q, p);
      },
    })) });
    assert.equal((await inspectTrainingCampIntegrity(syntheticDb('bytes'), c.scope)).reason, 'byte_budget');
    assert.equal((await inspectTrainingCampIntegrity(syntheticDb('rows'), c.scope)).reason, 'row_budget');
    assert.equal((await inspectTrainingCampIntegrity(syntheticDb('timeout'), c.scope)).reason, 'time_budget');
    await assert.rejects(inspectTrainingCampIntegrity(syntheticDb('permissions'), c.scope), /^Error: TRAININGCAMP_INTEGRITY_UNAVAILABLE$/);
    let called = false;
    await assert.rejects(inspectTrainingCampIntegrity({ transaction: async () => { called = true; throw new Error(); } },
      { ...c.scope, end: '2026-03-01T00:00:00Z' }), /INPUT_INVALID/); assert.equal(called, false);
    await c.pg.exec('DROP TABLE health_bridge.trainingcamp_sleep_records');
    const missing = await inspectTrainingCampIntegrity(c.db, c.scope);
    assert.equal(missing.status, 'incomplete'); assert.equal(missing.complete, false); assert.equal(missing.reason, 'missing_tables');
  } finally { await c.pg.close(); }
});

test('operator diagnostic rejects absent configuration and overlong input without echoing it', () => {
  for (const input of ['{}', 'x'.repeat(2049)]) {
    const env = { ...process.env }; delete env.HEALTH_DATABASE_URL; delete env.HEALTH_DATABASE_CA;
    const child = spawnSync(process.execPath, [fileURLToPath(new URL('../trainingcamp-integrity-diagnostic.mts', import.meta.url))],
      { input, env, encoding: 'utf8', timeout: 10000 });
    assert.equal(child.status, 1); assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'TRAININGCAMP_INTEGRITY_UNAVAILABLE' });
  }
});
