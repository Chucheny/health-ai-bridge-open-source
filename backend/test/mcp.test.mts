import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { generateKeyPair, exportJWK, createLocalJWKSet, SignJWT } from 'jose';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { parseMcpSettings, oauthVerifier } from '../mcp-auth.mts';
import { createMcpHandler } from '../mcp.mts';
import type { Database } from '../database.mts';
import { cursor, instantFromNs, ns, parseQuery, TYPES } from '../protocol.mts';
import deployed from '../../netlify/functions/mcp.mts';

const owner = randomUUID(), otherOwner = randomUUID();
const settings = parseMcpSettings({ resource: 'https://health.invalid/mcp', issuer: 'https://identity.invalid/auth',
  jwksUrl: 'https://identity.invalid/auth/jwks', subject: 'synthetic-user', clientId: 'synthetic-chatgpt-client',
  ownerId: owner, types: ['StepsRecord'] });
const keys = await generateKeyPair('RS256');
const jwk = { ...await exportJWK(keys.publicKey), kid: 'synthetic-key', alg: 'RS256' };
const verify = oauthVerifier(settings, createLocalJWKSet({ keys: [jwk] }));
async function token(change: Record<string, unknown> = {}) {
  const now = Math.floor(Date.now() / 1000);
  return new SignJWT({ iss: settings.issuer, aud: settings.resource, sub: settings.subject,
    iat: now, exp: now + 300, scope: 'health:read', client_id: settings.clientId, ...change })
    .setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).sign(keys.privateKey);
}
const args = { type: 'StepsRecord', start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' };
function rpc(method: string, params: unknown = {}, bearer?: string, extraHeaders: Record<string, string> = {}) {
  return new Request(settings.resource, { method: 'POST', headers: {
    'content-type': 'application/json', accept: 'application/json, text/event-stream',
    'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    ...(bearer ? { authorization: `Bearer ${bearer}` } : {}), ...extraHeaders,
  }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
}
const noDatabase: Database = { transaction: async () => { throw new Error('Database must not be opened'); } };

test('OAuth requires exact issuer, resource audience, user, client, expiry and read scope', async () => {
  assert.equal(await verify(await token()), true);
  assert.equal(await verify(await token({ scope: 'health:read offline_access' })), true);
  assert.equal(await verify(await token({ scope: 'offline_access' })), false);
  for (const change of [ { iss: 'https://wrong.invalid' }, { aud: 'authenticated' }, { sub: 'other-user' },
    { client_id: 'other-client' }, { client_id: undefined }, { scope: 'openid' },
    { exp: 1 }, { exp: undefined }, { iat: Math.floor(Date.now() / 1000) + 100 },
    { exp: Math.floor(Date.now() / 1000) + 7200 } ]) {
    assert.equal(await verify(await token(change)), false);
  }
  assert.equal(await verify('synthetic-phone-device-token'), false);
  const wrong = await generateKeyPair('RS256');
  const forged = await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'synthetic-key' }).sign(wrong.privateKey);
  assert.equal(await verify(forged), false);
});

test('OAuth discovery is public metadata while unauthenticated MCP cannot touch the database', async () => {
  const handler = createMcpHandler(noDatabase, settings, verify);
  const discovery = await handler(new Request('https://health.invalid/.well-known/oauth-protected-resource/mcp'));
  assert.equal(discovery.status, 200);
  const metadata = await discovery.json();
  assert.equal(metadata.resource, settings.resource);
  assert.deepEqual(metadata.scopes_supported, ['health:read', 'offline_access']);
  assert(!JSON.stringify(metadata).includes(owner));
  const denied = await handler(rpc('tools/list'));
  assert.equal(denied.status, 401);
  assert.match(denied.headers.get('www-authenticate')!, /oauth-protected-resource\/mcp/);
  assert.match(denied.headers.get('www-authenticate')!, /scope="health:read offline_access"/);
  assert.equal((await handler(rpc('tools/list', {}, 'invalid.jwt.value'))).status, 401);
});

test('real SDK initialization and listing expose only read-only tools, never control operations', async () => {
  const handler = createMcpHandler(noDatabase, settings, verify), bearer = await token();
  const initialized = await handler(rpc('initialize', { protocolVersion: LATEST_PROTOCOL_VERSION,
    capabilities: {}, clientInfo: { name: 'synthetic-client', version: '1' } }, bearer));
  assert.equal(initialized.status, 200);
  assert.equal((await initialized.json()).result.serverInfo.name, 'health-ai-bridge');
  const listed = await handler(rpc('tools/list', {}, bearer));
  assert.equal(listed.status, 200);
  const tools = (await listed.json()).result.tools;
  assert.deepEqual(tools.map((t: any) => t.name).sort(), ['health_records', 'health_summary']);
  assert(tools.every((t: any) => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  assert(tools.every((t: any) => JSON.stringify(t._meta.securitySchemes) ===
    JSON.stringify([{ type: 'oauth2', scopes: ['health:read', 'offline_access'] }])));
  const rejected = await handler(rpc('tools/call', { name: 'clearCloudData', arguments: {} }, bearer));
  const rejection = await rejected.json();
  assert(rejection.error || rejection.result?.isError === true);
});

test('mobile metadata probes distinguish forwarded Training Camp arguments before opening a database transaction', async () => {
  let transactions = 0;
  const database: Database = { transaction: async () => {
    transactions++;
    throw new Error('Metadata probes must not open the database');
  } };
  const handler = createMcpHandler(database, { ...settings, trainingCampEnabled: true }, verify);
  const bearer = await token();
  const zeroWindow = { start: '2000-01-01T00:00:00+08:00', end: '2000-01-01T00:00:00+08:00' };
  const snapshot = '00000000-0000-4000-8000-000000000000';
  async function expectError(name: string, parameters: Record<string, string>, expected: string) {
    const response = await handler(rpc('tools/call', { name, arguments: { ...zeroWindow, ...parameters } }, bearer));
    assert.equal(response.status, 200);
    const { result } = await response.json();
    assert.equal(result.isError, true);
    assert.equal(result.content[0].text, expected);
  }

  await expectError('health_summary', { source: 'huawei_trainingcamp', snapshot }, 'sleep_type_required');
  await expectError('health_summary', { source: 'huawei_trainingcamp' }, 'invalid_range');
  await expectError('health_summary', { snapshot }, 'snapshot_not_supported');
  await expectError('health_records', { type: 'SleepSessionRecord', source: 'health_sync', sleepStages: 'paged' },
    'sleep_stage_paging_not_supported');
  await expectError('health_records', { type: 'SleepSessionRecord', source: 'health_sync' }, 'invalid_range');
  assert.equal(transactions, 0);
});

test('MCP reads only its server-bound owner and types in actual READ ONLY SQL transactions', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));
    for (const [id, value] of [[owner, 321], [otherOwner, 999]] as const) {
      await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [id]);
      await pg.query(`INSERT INTO health_bridge.health_records
        (owner_id,source_id,record_type,hc_id,origin,modified_ns,start_ns,end_ns,start_at,payload)
        VALUES($1,$2,'StepsRecord',$3,'nl.appyhapps.healthsync',0,$4,$5,$6,$7)`,
      [id, randomUUID(), randomUUID(), ns('2026-01-01T00:00:00Z').toString(), ns('2026-01-02T00:00:00Z').toString(),
        '2026-01-01T00:00:00Z', { recordType: 'StepsRecord', value, unit: 'steps' }]);
    }
    let readonly = false;
    const db: Database = { transaction: fn => pg.transaction(async tx => {
      const result = await fn({ query: (sql, params) => tx.query<any>(sql, params) });
      readonly = (await tx.query<any>("SELECT current_setting('transaction_read_only') AS value")).rows[0].value === 'on';
      return result;
    }) };
    const handler = createMcpHandler(db, settings, verify), bearer = await token();
    const response = await handler(rpc('tools/call', { name: 'health_records', arguments: args }, bearer));
    assert.equal(response.status, 200);
    const result = (await response.json()).result;
    assert.equal(result.isError, undefined);
    const data = JSON.parse(result.content[0].text);
    assert.deepEqual(data.records.map((r: any) => r.record.value), [321]);
    assert.equal(data.availability.resultScope, 'returned_page');
    assert.equal(data.availability.upstreamSyncFreshness, 'unknown');
    assert.equal(data.availability.sourceCompleteness, 'unknown');
    assert.deepEqual(data.availability.requestedWindow, { start: args.start, end: args.end, endExclusive: true });
    assert(Number.isFinite(Date.parse(data.availability.queryCompletedAt)));
    assert.equal(readonly, true);
    const denied = await handler(rpc('tools/call', { name: 'health_records', arguments: { ...args, type: 'HeartRateRecord' } }, bearer));
    assert.equal((await denied.json()).result.content[0].text, 'forbidden');
    const crossed = await handler(rpc('tools/call', { name: 'health_records', arguments: { ...args, ownerId: otherOwner } }, bearer));
    assert.equal((await crossed.json()).result.isError, true);
  } finally { await pg.close(); }
});

test('untrusted origins, query-string credentials, wide ranges and oversized requests are rejected', async () => {
  const handler = createMcpHandler(noDatabase, settings, verify), bearer = await token();
  assert.equal((await handler(rpc('tools/list', {}, bearer, { origin: 'https://evil.invalid' }))).status, 403);
  assert.equal((await handler(new Request(settings.resource + '?token=synthetic'))).status, 400);
  const wide = await handler(rpc('tools/call', { name: 'health_records', arguments: { ...args, end: '2026-03-01T00:00:00Z' } }, bearer));
  assert.equal((await wide.json()).result.content[0].text, 'invalid_range');
  const boundary = await handler(rpc('tools/call', { name: 'health_records', arguments: {
    ...args, end: '2026-02-01T00:00:00.000000001Z' } }, bearer));
  assert.equal((await boundary.json()).result.content[0].text, 'invalid_range');
  const huge = new Request(settings.resource, { method: 'POST', headers: {
    authorization: `Bearer ${bearer}`, 'content-type': 'application/json' }, body: 'x'.repeat(65537) });
  assert.equal((await handler(huge)).status, 413);
});

test('unconfigured or non-production deployment stays closed without database access', async () => {
  const previous = (globalThis as any).Netlify;
  try {
    (globalThis as any).Netlify = { env: { get: () => undefined } };
    for (const deploy of [{ context: 'production', published: true }, { context: 'dev', published: false }]) {
      const response = await deployed(new Request(settings.resource), { deploy } as any);
      assert.equal(response.status, 503);
      assert.deepEqual(await response.json(), { error: 'service_not_configured' });
    }
  } finally { (globalThis as any).Netlify = previous; }
});

test('MCP authorization window configuration is strict and preserves legacy configuration compatibility', () => {
  assert.equal(settings.readWindow, undefined);
  const readWindow = { start: args.start, end: args.end };
  assert.deepEqual(parseMcpSettings({ ...settings, readWindow }).readWindow, readWindow);
  for (const window of [{ start: args.start }, { start: args.end, end: args.start },
    { start: args.start, end: args.start }, { ...readWindow, start: '2026-01-01T00:00:00' },
    { ...readWindow, unrestricted: true }]) {
    assert.throws(() => parseMcpSettings({ ...settings, readWindow: window }), /^Error: Invalid MCP configuration$/);
  }
});

test('out-of-window MCP requests and client-injected permission fields are rejected before opening SQL', async () => {
  const scoped = parseMcpSettings({ ...settings, readWindow: { start: args.start, end: args.end } });
  const handler = createMcpHandler(noDatabase, scoped, verify), bearer = await token();
  for (const change of [{ start: '2025-12-31T23:59:59.999999999Z' },
    { end: '2026-01-03T00:00:00.000000001Z' }]) {
    for (const name of ['health_summary', 'health_records']) {
      const response = await handler(rpc('tools/call', { name, arguments: { ...args, ...change } }, bearer));
      assert.equal((await response.json()).result.content[0].text, 'outside_authorized_window');
    }
  }
  const crossed = await handler(rpc('tools/call', { name: 'health_records',
    arguments: { ...args, readWindow: { start: '2000-01-01T00:00:00Z', end: '2099-01-01T00:00:00Z' } } }, bearer));
  assert.equal((await crossed.json()).result.isError, true);
  const denied = await handler(rpc('tools/call', { name: 'health_summary',
    arguments: { ...args, type: 'HeartRateRecord' } }, bearer));
  assert.equal((await denied.json()).result.content[0].text, 'forbidden');
});

test('all fifteen types work within a bound window while crossing records and endpoint samples stay private', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));
    await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [owner]);
    const source = randomUUID();
    async function insert(type: string, id: string, start: string, end: string, sample?: string) {
      const key = (await pg.query<any>(`INSERT INTO health_bridge.health_records
        (owner_id,source_id,record_type,hc_id,origin,modified_ns,start_ns,end_ns,start_at,payload)
        VALUES($1,$2,$3,$4,'nl.appyhapps.healthsync',0,$5,$6,$7,$8) RETURNING record_key`,
      [owner, source, type, id, ns(start).toString(), ns(end).toString(), start,
        { recordType: type, id, value: 1 }])).rows[0].record_key;
      if (sample) await pg.query(`INSERT INTO health_bridge.samples(record_key,sample_index,time_ns,time_text,value,unit)
        VALUES($1,0,$2,$3,60,'BPM')`, [key, ns(sample).toString(), sample]);
    }
    for (const type of TYPES) await insert(type, 'contained-' + type, '2026-01-02T00:00:00Z', '2026-01-02T00:01:00Z');
    await insert('HeartRateRecord', 'private-crosses-start', '2025-12-31T23:59:59.999999999Z', '2026-01-02T00:00:00Z');
    await insert('HeartRateRecord', 'private-crosses-end', '2026-01-02T00:00:00Z', '2026-01-03T00:00:00.000000001Z');
    await insert('HeartRateRecord', 'private-sample-at-exclusive-end', '2026-01-02T00:00:00Z', args.end, args.end);
    await insert('HeartRateRecord', 'contained-end-without-outside-sample', '2026-01-02T00:00:00Z', args.end,
      '2026-01-02T23:59:59.999999999Z');
    await insert('WeightRecord', 'private-point-at-exclusive-end', args.end, args.end);
    const db: Database = { transaction: fn => pg.transaction(tx => fn({ query: (sql, params) => tx.query<any>(sql, params) })) };
    const scoped = parseMcpSettings({ ...settings, types: [...TYPES], readWindow: { start: args.start, end: args.end } });
    const handler = createMcpHandler(db, scoped, verify), bearer = await token();
    for (const type of TYPES) {
      const response = await handler(rpc('tools/call', { name: 'health_summary', arguments: {
        ...args, type, start: '2026-01-01T08:00:00+08:00', end: '2026-01-03T08:00:00+08:00',
      } }, bearer));
      const result = (await response.json()).result;
      assert.notEqual(result.isError, true);
      const data = JSON.parse(result.content[0].text);
      assert.equal(data.type, type);
      assert.equal(data.bySource[0].record_count, type === 'HeartRateRecord' ? '2' : '1');
      assert.match(data.authorizationPolicy, /fully contained/);
    }
    const raw = await handler(rpc('tools/call', { name: 'health_records', arguments: { ...args, type: 'HeartRateRecord', limit: 1 } }, bearer));
    const first = JSON.parse((await raw.json()).result.content[0].text);
    assert.equal(first.records.length, 1); assert(first.nextCursor);
    const next = await handler(rpc('tools/call', { name: 'health_records', arguments: {
      ...args, type: 'HeartRateRecord', limit: 1, cursor: first.nextCursor,
    } }, bearer));
    const second = JSON.parse((await next.json()).result.content[0].text);
    assert.equal(second.records[0].record.id, 'contained-end-without-outside-sample');
    assert.equal(second.nextCursor, null);
    assert(!JSON.stringify([first, second]).includes('private-'));
  } finally { await pg.close(); }
});

test('derived coverage timestamps round-trip nanoseconds, offsets and pre-epoch values', () => {
  for (const value of ['2026-01-01T00:00:00.000000001Z', '2026-01-01T08:00:00.999999999+08:00',
    '1970-01-01T00:00:00Z', '1969-12-31T23:59:59.999999999Z', '1900-01-01T00:00:00.123456789Z']) {
    assert.equal(ns(instantFromNs(ns(value).toString())), ns(value));
  }
  assert.equal(instantFromNs('-1'), '1969-12-31T23:59:59.999999999Z');
});

test('MCP availability separates record bounds from in-window samples, unknown freshness and empty pages', async () => {
  const pg = new PGlite();
  try {
    await pg.exec(await readFile(new URL('../migrations/001_health_bridge.sql', import.meta.url), 'utf8'));
    for (const id of [owner, otherOwner]) await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [id]);
    const sourceA = randomUUID(), sourceB = randomUUID();
    const scoped = parseMcpSettings({ ...settings, types: [...TYPES], readWindow: { start: args.start, end: args.end } });
    const db: Database = { transaction: fn => pg.transaction(tx => fn({ query: (sql, params) => tx.query<any>(sql, params) })) };
    const handler = createMcpHandler(db, scoped, verify), bearer = await token();
    async function insert(id: string, origin: string, source: string, start: string, end: string,
      samples: string[] = [], account = owner, deleted = false) {
      const key = (await pg.query<any>(`INSERT INTO health_bridge.health_records
        (owner_id,source_id,record_type,hc_id,origin,modified_ns,start_ns,end_ns,start_at,payload,deleted)
        VALUES($1,$2,'HeartRateRecord',$3,$4,0,$5,$6,$7,$8,$9) RETURNING record_key`,
      [account, source, id, origin, ns(start).toString(), ns(end).toString(), start,
        { recordType: 'HeartRateRecord', id, startTime: start, endTime: end }, deleted])).rows[0].record_key;
      for (const [i, time] of samples.entries()) await pg.query(`INSERT INTO health_bridge.samples
        (record_key,sample_index,time_ns,time_text,value,unit) VALUES($1,$2,$3,$4,60,'BPM')`,
      [key, i, ns(time).toString(), time]);
    }
    const firstSample = '2026-01-02T00:00:00.000000001Z', lastSample = '2026-01-02T02:59:59.999999999Z';
    await insert('wide-record', 'nl.appyhapps.healthsync', sourceA, '2026-01-01T23:00:00Z', '2026-01-02T04:00:00Z',
      ['2026-01-01T23:30:00Z', firstSample, lastSample, '2026-01-02T03:00:00Z']);
    await insert('second-record', 'nl.appyhapps.healthsync', sourceA, '2026-01-02T01:00:00Z', '2026-01-02T02:00:00Z', ['2026-01-02T01:30:00Z']);
    await insert('no-samples', 'nl.appyhapps.healthsync', sourceB, '2026-01-02T01:00:00Z', '2026-01-02T01:30:00Z');
    await insert('private-crosses-authorization', 'private.crosses', sourceA, '2025-12-31T00:00:00Z', args.end);
    await insert('private-owner', 'private.owner', sourceA, args.start, args.end, [], otherOwner);
    await insert('private-deleted', 'private.deleted', sourceA, args.start, args.end, [], owner, true);
    const query = { type: 'HeartRateRecord', start: '2026-01-02T08:00:00+08:00', end: '2026-01-02T11:00:00+08:00' };
    async function call(name: string, argumentsValue: unknown) {
      const response = await handler(rpc('tools/call', { name, arguments: argumentsValue }, bearer));
      const result = (await response.json()).result;
      assert.notEqual(result.isError, true);
      return JSON.parse(result.content[0].text);
    }
    const before = Date.now();
    const data = await call('health_summary', query);
    assert(Date.parse(data.availability.queryCompletedAt) >= before);
    assert(Date.parse(data.availability.queryCompletedAt) <= Date.now());
    assert.equal(data.availability.resultScope, 'all_matching_records');
    assert.equal(data.availability.upstreamSyncFreshness, 'unknown');
    assert.equal(data.availability.sourceCompleteness, 'unknown');
    assert.deepEqual(data.availability.requestedWindow, { start: query.start, end: query.end, endExclusive: true });
    assert.equal(data.bySource.length, 2);
    const a = data.bySource.find((r: any) => r.source_id === sourceA);
    assert.equal(a.record_count, '2'); assert.equal(a.sample_count, '3');
    assert.deepEqual(a.recordTimeBounds, { earliestStart: '2026-01-01T23:00:00.000000000Z', latestEnd: '2026-01-02T04:00:00.000000000Z' });
    assert.deepEqual(a.sampleTimeBounds, { earliest: firstSample, latest: lastSample });
    assert.equal(data.bySource.find((r: any) => r.source_id === sourceB).sampleTimeBounds, null);
    assert(!JSON.stringify(data).includes('private.'));
    assert(!JSON.stringify(data).includes('first_record_ns'));
    const deniedOrigin=await handler(rpc('tools/call',{name:'health_summary',arguments:{...query,origin:'source.b'}},bearer));
    assert.equal((await deniedOrigin.json()).result.content[0].text,'origin_not_allowed');
    const absent = await call('health_summary', { ...query, type: 'WeightRecord' });
    assert.deepEqual(absent.bySource, []);
    assert.equal(absent.availability.sourceCompleteness, 'unknown');
    const firstPage = await call('health_records', { ...query, limit: 1 });
    assert(firstPage.nextCursor); assert.equal(firstPage.availability.resultScope, 'returned_page');
    const url = new URL('https://health.invalid/query');
    for (const [key, value] of Object.entries(query)) url.searchParams.set(key, value);
    const emptyPage = await call('health_records', { ...query, cursor: cursor(parseQuery(url), '999999999') });
    assert.deepEqual(emptyPage.records, []); assert.equal(emptyPage.nextCursor, null);
    assert.equal(emptyPage.availability.resultScope, 'returned_page');
    assert.equal(emptyPage.availability.sourceCompleteness, 'unknown');
  } finally { await pg.close(); }
});
