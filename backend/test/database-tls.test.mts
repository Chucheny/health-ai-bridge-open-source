import { test } from 'node:test';
import assert from 'node:assert/strict';
import pg from 'pg';
import { postgresDatabase } from '../database.mts';

// Inspect pg's real final parser without opening a socket or reading configuration.
const syntheticCa = 'synthetic-ca-for-parser-test-only';
const syntheticPassword = 'synthetic-secret@:/?';
type FinalConnection = {
  user: string; password: string; host: string; port: number; database: string;
  ssl: false | true | { rejectUnauthorized?: boolean; ca?: unknown };
};

async function finalConnection(protocol: 'postgres:' | 'postgresql:', query: string, ca?: string): Promise<FinalConnection> {
  const originalPool = pg.Pool;
  let captured: pg.PoolConfig | undefined;
  let closed = false;
  class CapturePool {
    constructor(options: pg.PoolConfig) { captured = options; }
    on() { return this; }
    async connect(): Promise<never> { throw new Error('Test must never open a database connection'); }
    async end() { closed = true; }
  }
  try {
    (pg as unknown as { Pool: unknown }).Pool = CapturePool;
    const url = new URL('postgresql://synthetic-db.invalid:6543/synthetic_database');
    url.username = 'synthetic-user';
    url.password = syntheticPassword;
    url.protocol = protocol;
    url.search = query;
    const database = postgresDatabase(url.toString(), ca);
    assert(captured, 'Pool constructor must receive configuration');
    // Client construction invokes pg-connection-string's actual override rules.
    // Calling connect() is deliberately forbidden by this test harness.
    const client = new pg.Client(captured);
    const parsed = (client as unknown as { connectionParameters: FinalConnection }).connectionParameters;
    await database.close?.();
    assert.equal(closed, true);
    return parsed;
  } finally { pg.Pool = originalPool; }
}

function assertSyntheticConnection(parsed: FinalConnection) {
  assert.equal(parsed.user, 'synthetic-user');
  assert.equal(parsed.password, syntheticPassword);
  assert.equal(parsed.host, 'synthetic-db.invalid');
  assert.equal(parsed.port, 6543);
  assert.equal(parsed.database, 'synthetic_database');
}

function tlsProblems(parsed: FinalConnection, ca?: string): string[] {
  const problems = [];
  if (typeof parsed.ssl !== 'object' || parsed.ssl === null) problems.push('TLS verification options replaced');
  else {
    if (parsed.ssl.rejectUnauthorized !== true) problems.push('certificate verification not enforced');
    if (ca !== undefined && parsed.ssl.ca !== ca) problems.push('configured CA lost');
    if (ca === undefined && parsed.ssl.ca !== undefined) problems.push('unexpected CA');
  }
  return problems;
}

test('plain PostgreSQL URLs retain verified TLS, optional CA and exact synthetic connection parameters', async () => {
  for (const protocol of ['postgres:', 'postgresql:'] as const) {
    for (const ca of [undefined, syntheticCa]) {
      const parsed = await finalConnection(protocol, '', ca);
      assertSyntheticConnection(parsed);
      assert.deepEqual(tlsProblems(parsed, ca), []);
    }
  }
});

test('ssl URL values cannot replace verified TLS or discard the configured CA after pg parsing', async () => {
  const failures: { protocol: string; query: string; withCa: boolean; problems: string[] }[] = [];
  for (const protocol of ['postgres:', 'postgresql:'] as const) {
    for (const ca of [undefined, syntheticCa]) {
      for (const query of ['ssl=0', 'ssl=false', 'ssl=no-verify', 'ssl=true', 'ssl=1']) {
        const parsed = await finalConnection(protocol, query, ca);
        assertSyntheticConnection(parsed);
        const problems = tlsProblems(parsed, ca);
        if (problems.length) failures.push({ protocol, query, withCa: ca !== undefined, problems });
      }
    }
  }
  assert.deepEqual(failures, []);
});

test('duplicate and combined TLS URL flags cannot weaken pg final certificate validation', async () => {
  const failures: { protocol: string; query: string; withCa: boolean; problems: string[] }[] = [];
  const queries = [
    'sslmode=disable', 'sslmode=require', 'sslmode=no-verify',
    'ssl=0&sslmode=require', 'sslmode=disable&ssl=no-verify',
    'ssl=1&ssl=0', 'ssl=0&ssl=1', 'ssl=false&ssl=no-verify',
    'sslmode=no-verify&uselibpqcompat=true', 'sslmode=verify-full&ssl=true',
    'sslmode=require&sslmode=disable',
    'sslnegotiation=direct', 'sslnegotiation=direct&sslmode=verify-full',
    'sslnegotiation=direct&ssl=no-verify',
  ];
  for (const protocol of ['postgres:', 'postgresql:'] as const) {
    for (const ca of [undefined, syntheticCa]) {
      for (const query of queries) {
        const parsed = await finalConnection(protocol, query, ca);
        assertSyntheticConnection(parsed);
        const problems = tlsProblems(parsed, ca);
        if (problems.length) failures.push({ protocol, query, withCa: ca !== undefined, problems });
      }
    }
  }
  assert.deepEqual(failures, []);
});
