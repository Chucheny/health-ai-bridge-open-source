import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { PGlite } from '@electric-sql/pglite';
import { CAPACITY_TABLES, inspectCapacity } from '../capacity.mts';
import type { Database, Sql } from '../database.mts';

// Only disposable local PostgreSQL fixtures. No actual database configuration is read.
const expectedTables = ['accounts', 'device_tokens', 'health_records', 'samples',
  'sleep_stages', 'sync_batches', 'sync_streams'];
const observedAt = '2026-01-02T03:04:05.678Z';
const clock = () => new Date(observedAt);
const migrate = async (pg: PGlite) => pg.exec(await readFile(
  new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));

function adapter(pg: PGlite, capture?: (settings: any) => void, verifyReadOnlyWrites = false): Database {
  return { async transaction<T>(fn: (sql: Sql) => Promise<T>) {
    return pg.transaction(async tx => {
      const result = await fn({ query: (sql, params) => tx.query<any>(sql, params) });
      if (capture) capture((await tx.query(`SELECT
        current_setting('transaction_read_only') AS read_only,
        current_setting('statement_timeout') AS statement_timeout,
        current_setting('lock_timeout') AS lock_timeout,
        current_user AS role`)).rows[0]);
      if (verifyReadOnlyWrites) {
        // This unrelated synthetic probe grants UPDATE, so ACL denial cannot masquerade
        // as enforcement of the capacity function's read-only transaction.
        await tx.query('SAVEPOINT capacity_readonly_proof');
        let failure: unknown;
        try { await tx.query('UPDATE public.capacity_write_probe SET id=2'); }
        catch (error) { failure = error; }
        await tx.query('ROLLBACK TO SAVEPOINT capacity_readonly_proof');
        await tx.query('RELEASE SAVEPOINT capacity_readonly_proof');
        assert.equal((failure as { code?: string } | undefined)?.code, '25006');
      }
      return result;
    });
  } };
}

test('capacity reads sizes with schema-only role, actual read-only limits and unchanged private fixtures', async () => {
  const pg = new PGlite();
  try {
    await migrate(pg);
    const owner = randomUUID();
    const source = randomUUID();
    const privateId = 'synthetic-health-record-private-id';
    const payload = { marker: 'synthetic-private-health-value', bpm: 137.125 };
    const tokenHash = 'a'.repeat(64);
    await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [owner]);
    await pg.query(`INSERT INTO health_bridge.health_records
      (owner_id,source_id,record_type,hc_id,payload) VALUES($1,$2,$3,$4,$5)`,
    [owner, source, 'HeartRateRecord', privateId, JSON.stringify(payload)]);
    await pg.query(`INSERT INTO health_bridge.device_tokens
      (token_hash,owner_id,source_id,scopes,allowed_types) VALUES($1,$2,$3,$4,$5)`,
    [tokenHash, owner, source, ['read'], ['HeartRateRecord']]);
    const healthBefore = (await pg.query('SELECT hc_id,payload FROM health_bridge.health_records')).rows;
    const tokenBefore = (await pg.query('SELECT token_hash,scopes,revoked_at FROM health_bridge.device_tokens')).rows;
    const countsBefore = [];
    for (const table of expectedTables) countsBefore.push((await pg.query(
      `SELECT count(*)::text AS n FROM health_bridge.${table}`)).rows[0]);

    await pg.exec(`CREATE TABLE public.capacity_write_probe(id integer);
      INSERT INTO public.capacity_write_probe VALUES(1);
      CREATE ROLE capacity_reader NOLOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOBYPASSRLS;
      GRANT CONNECT ON DATABASE postgres TO capacity_reader;
      GRANT USAGE ON SCHEMA health_bridge TO capacity_reader;
      GRANT SELECT,UPDATE ON public.capacity_write_probe TO capacity_reader;
      SET ROLE capacity_reader`);
    const privileges = (await pg.query(`SELECT
      has_table_privilege(current_user,'health_bridge.health_records','SELECT') AS health_select,
      has_table_privilege(current_user,'health_bridge.device_tokens','SELECT') AS token_select`)).rows[0];
    assert.deepEqual(privileges, { health_select: false, token_select: false });
    await assert.rejects(pg.query('SELECT payload FROM health_bridge.health_records'));
    let settings: any;
    const report = await inspectCapacity(adapter(pg, value => { settings = value; }, true), clock);
    assert.deepEqual(settings, { read_only: 'on', statement_timeout: '5s', lock_timeout: '2s', role: 'capacity_reader' });
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.observedAt, observedAt);
    assert.equal(report.readOnly, true);
    assert.equal(report.schemaPresent, true);
    assert.equal(report.complete, true);
    assert.deepEqual(report.missingTables, []);
    assert.deepEqual([...CAPACITY_TABLES], expectedTables);
    assert.deepEqual(report.tables.map(row => row.table).sort(), expectedTables);
    const text = JSON.stringify(report);
    for (const secret of [owner, source, privateId, payload.marker, String(payload.bpm), tokenHash]) {
      assert(!text.includes(secret), 'capacity output must not contain fixture data');
    }

    await pg.exec('RESET ROLE');
    assert.deepEqual((await pg.query('SELECT id FROM public.capacity_write_probe')).rows, [{ id: 1 }]);
    assert.deepEqual((await pg.query('SELECT hc_id,payload FROM health_bridge.health_records')).rows, healthBefore);
    assert.deepEqual((await pg.query('SELECT token_hash,scopes,revoked_at FROM health_bridge.device_tokens')).rows, tokenBefore);
    const countsAfter = [];
    for (const table of expectedTables) countsAfter.push((await pg.query(
      `SELECT count(*)::text AS n FROM health_bridge.${table}`)).rows[0]);
    assert.deepEqual(countsAfter, countsBefore);
  } finally { await pg.close(); }
});

test('missing schema and an expected name replaced by a view stay incomplete without initialization', async () => {
  const empty = new PGlite();
  try {
    const report = await inspectCapacity(adapter(empty), clock);
    assert.equal(report.schemaPresent, false);
    assert.equal(report.complete, false);
    assert.deepEqual(report.missingTables, expectedTables);
    assert.deepEqual(report.tables, []);
    assert.equal(report.selectedTablesBytes, '0');
    assert.equal(report.selectedTableDataBytes, '0');
    assert.equal(report.selectedIndexBytes, '0');
    assert.equal((await empty.query<{ present: boolean }>(`SELECT EXISTS(
      SELECT 1 FROM pg_namespace WHERE nspname='health_bridge') AS present`)).rows[0].present, false);
  } finally { await empty.close(); }

  const partial = new PGlite();
  try {
    await migrate(partial);
    await partial.exec('DROP TABLE health_bridge.sleep_stages');
    const report = await inspectCapacity(adapter(partial), clock);
    assert.equal(report.schemaPresent, true);
    assert.equal(report.complete, false);
    assert.deepEqual(report.missingTables, ['sleep_stages']);
    assert.equal(report.tables.length, 6);
    await partial.exec('CREATE VIEW health_bridge.sleep_stages AS SELECT 1 AS stage');
    const withView = await inspectCapacity(adapter(partial), clock);
    assert.equal(withView.complete, false);
    assert.deepEqual(withView.missingTables, ['sleep_stages']);
    assert.equal((await partial.query<{ relkind: string }>(`SELECT relkind FROM pg_class c JOIN pg_namespace n
      ON n.oid=c.relnamespace WHERE n.nspname='health_bridge' AND c.relname='sleep_stages'`)).rows[0].relkind, 'v');
  } finally { await partial.close(); }
});

test('selected sizes include only seven ordinary health_bridge tables despite unrelated tables and namesakes', async () => {
  const pg = new PGlite();
  try {
    await migrate(pg);
    await pg.exec(`CREATE TABLE health_bridge.unrelated_private_archive(body text);
      INSERT INTO health_bridge.unrelated_private_archive VALUES(repeat('synthetic-private-archive',5000));
      CREATE SCHEMA external_storage;
      CREATE TABLE external_storage.samples(body text);
      INSERT INTO external_storage.samples VALUES(repeat('synthetic-external',5000))`);
    const report = await inspectCapacity(adapter(pg), clock);
    assert.equal(report.complete, true);
    assert.deepEqual(report.tables.map(row => row.table).sort(), expectedTables);
    let actualTotal = 0n;
    for (const table of expectedTables) {
      const row = (await pg.query<{ bytes: string }>(
        'SELECT pg_total_relation_size($1::regclass)::text AS bytes', [`health_bridge.${table}`])).rows[0];
      actualTotal += BigInt(row.bytes);
    }
    assert.equal(report.selectedTablesBytes, actualTotal.toString());
    assert.equal(BigInt(report.selectedTablesBytes), BigInt(report.selectedTableDataBytes) + BigInt(report.selectedIndexBytes));
    assert(!JSON.stringify(report).includes('unrelated_private_archive'));
    assert(!JSON.stringify(report).includes('external_storage'));
  } finally { await pg.close(); }
});

const meta = () => [{ database_bytes: '9223372036854775807', read_only: 'on', schema_present: true }];
const rows = () => CAPACITY_TABLES.map(table => ({
  table_name: table, table_bytes: '9007199254740993', index_bytes: '9007199254740995',
}));
function fakeDatabase(metaRows: any[] = meta(), tableRows: any[] = rows()): Database {
  return { async transaction<T>(fn: (sql: Sql) => Promise<T>) {
    return fn({ async query(sql) {
      if (sql.includes('pg_database_size')) return { rows: metaRows };
      if (sql.includes('pg_class')) return { rows: tableRows };
      return { rows: [] };
    } });
  } };
}

test('byte totals retain exact decimal strings above JavaScript safe integer precision', async () => {
  const report = await inspectCapacity(fakeDatabase(), clock);
  const dataBytes = 9007199254740993n * 7n;
  const indexBytes = 9007199254740995n * 7n;
  assert.equal(report.databaseBytes, '9223372036854775807');
  assert.equal(report.selectedTableDataBytes, dataBytes.toString());
  assert.equal(report.selectedIndexBytes, indexBytes.toString());
  assert.equal(report.selectedTablesBytes, (dataBytes + indexBytes).toString());
  assert.equal(report.tables[0].tableBytes, '9007199254740993');
  assert.equal(report.tables[0].totalBytes, '18014398509481988');
  assert.equal(typeof report.tables[0].indexBytes, 'string');
});

async function rejectsPrivately(operation: Promise<unknown>) {
  await assert.rejects(operation, error => {
    assert(error instanceof Error);
    assert.equal(error.message, 'Capacity inspection unavailable');
    assert.equal(error.cause, undefined);
    return true;
  });
}

test('invalid metadata, unsafe byte encodings, duplicates and unexpected tables fail without private details', async () => {
  const secret = 'synthetic-private-driver-secret';
  const badMetadata = [[], [...meta(), ...meta()], [{ ...meta()[0], database_bytes: 42 }],
    [{ ...meta()[0], database_bytes: '-1' }], [{ ...meta()[0], database_bytes: '1e3' }],
    [{ ...meta()[0], read_only: 'off' }], [{ ...meta()[0], secret }]];
  for (const value of badMetadata) await rejectsPrivately(inspectCapacity(fakeDatabase(value), clock));
  for (const value of [-1, '1e3', '-1', '01', '9223372036854775808', secret]) {
    const tables: any[] = rows();
    tables[0] = { ...tables[0], table_bytes: value };
    await rejectsPrivately(inspectCapacity(fakeDatabase(meta(), tables), clock));
  }
  const invalidIndexes: any[] = rows(); invalidIndexes[0].index_bytes = 1;
  const duplicate = rows(); duplicate[6] = { ...duplicate[0] };
  const unexpected: any[] = rows(); unexpected[0].table_name = secret;
  const extraField: any[] = rows(); extraField[0].payload = secret;
  for (const value of [invalidIndexes, duplicate, unexpected, extraField]) {
    await rejectsPrivately(inspectCapacity(fakeDatabase(meta(), value), clock));
  }
});

test('permission/driver failures and invalid observation dates are sanitized without causes', async () => {
  const broken: Database = { async transaction() {
    throw new Error('permission denied; synthetic-private-driver-secret', { cause: 'synthetic-private-url' });
  } };
  await rejectsPrivately(inspectCapacity(broken, clock));
  let entered = false;
  const untouched: Database = { async transaction() { entered = true; throw new Error(); } };
  await rejectsPrivately(inspectCapacity(untouched, () => new Date('invalid synthetic-private-date')));
  assert.equal(entered, false);
});

test('operator CLI rejects missing or malformed configuration with fixed JSON and no echo', () => {
  const entry = fileURLToPath(new URL('../capacity-diagnostic.mts', import.meta.url));
  for (const value of [undefined, 'synthetic-private-url', 'https://synthetic-private.invalid']) {
    const env = { ...process.env };
    delete env.HEALTH_DATABASE_URL;
    delete env.HEALTH_DATABASE_CA;
    if (value !== undefined) env.HEALTH_DATABASE_URL = value;
    const child = spawnSync(process.execPath, [entry], { env, encoding: 'utf8', timeout: 10_000 });
    assert.equal(child.error, undefined);
    assert.equal(child.status, 1);
    assert.equal(child.stdout, '');
    assert.deepEqual(JSON.parse(child.stderr), { error: 'CAPACITY_INSPECTION_FAILED' });
    assert(!child.stderr.includes('synthetic-private'));
  }
});
