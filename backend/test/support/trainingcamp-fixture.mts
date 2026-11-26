// Shared synthetic fixture for operator checks and in-memory recovery. Never reads private configuration.
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHandler } from '../../api.mts';
import { createMcpHandler } from '../../mcp.mts';
import { parseMcpSettings } from '../../mcp-auth.mts';
import type { Database } from '../../database.mts';
import { hash, TYPES } from '../../protocol.mts';

export const auditWindow = { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' };
export const migrations = ['001_health_bridge.sql', '002_trainingcamp_activities.sql', '003_trainingcamp_sleep.sql'];
export function bindSyntheticDatabase(pg: PGlite, identity: { owner: string; source: string; token: string }, trainingCampEnabled = true) {
  const db: Database = { transaction: fn => pg.transaction(tx => fn({ query: (text, params) => tx.query<any>(text, params) })) };
  const api = createHandler(db, undefined, { trainingCampEnabled });
  async function request(path: string, body?: unknown, method?: string, handler = api, headers: Record<string, string> = {}) {
    const res = await handler(new Request('https://bridge.invalid/api/health/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: 'Bearer ' + identity.token, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: res.status, body: await res.json() as any };
  }
  const settings = parseMcpSettings({ resource: 'https://bridge.invalid/mcp', issuer: 'https://identity.invalid',
    jwksUrl: 'https://identity.invalid/jwks', subject: 'synthetic-user', clientId: 'synthetic-client',
    ownerId: identity.owner, types: [...TYPES], readWindow: auditWindow, trainingCampEnabled });
  const mcp = createMcpHandler(db, settings, async () => true);
  async function call(name: string, args: Record<string, unknown>) {
    const res = await mcp(new Request(settings.resource, { method: 'POST', headers: {
      authorization: 'Bearer synthetic-mcp-token', 'content-type': 'application/json', accept: 'application/json, text/event-stream',
      'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: { ...auditWindow, ...args } } }) }));
    return (await res.json() as any).result;
  }
  return { pg, ...identity, db, api, request, call,
    scope: { ownerId: identity.owner, sourceId: identity.source, ...auditWindow } };
}
export function syntheticSleepBatch(stageCount = 2, types = [1, 3, 99]): any {
  const base = 1767304800000123456n;
  return { schemaVersion: 1, batchId: randomUUID(), source: 'huawei_trainingcamp', authorizedWindow: auditWindow,
    capture: { schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'sleep', requestedWindow: auditWindow,
      apiRequest: { startTimeNs: '1767225600000000000', endTimeNs: '1767398399999999999' },
      capturedAt: auditWindow.end, sourceCompleteness: 'unknown', rawResponse: JSON.stringify({ healthRecords: types.map((type, i) => {
        const start = base + BigInt(i) * 3600000000000n, end = start + 1800000000000n;
        const count = i === 0 ? stageCount : 1, step = (end - start) / BigInt(Math.max(count, 1));
        return { id: 'synthetic-repeated-sleep-id', startTime: start.toString(), endTime: end.toString(),
          dataTypeName: 'com.huawei.health.record.sleep', originalDataCollectorId: 'synthetic-collector', timeZone: '+0800',
          value: [{ fieldName: 'sleep_type', integerValue: type }, { fieldName: 'all_sleep_time', integerValue: 25 }],
          subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: Array.from({ length: count }, (_, j) => ({
            startTime: (start + BigInt(j) * step).toString(), endTime: (start + BigInt(j + 1) * step).toString(),
            value: [{ fieldName: 'stage', integerValue: j % 5 === 4 ? 99 : j % 4 + 1,
              syntheticIndex: j, syntheticExtra: 'x'.repeat(stageCount > 200 ? 500 : 1) }],
          })) } } };
      }) }) } };
}
export function syntheticActivityBatch(): any {
  return { schemaVersion: 1, batchId: randomUUID(), source: 'huawei_trainingcamp', requestedWindow: auditWindow,
    records: [{ id: randomUUID(), startTime: 1767229200000, endTime: 1767232800000, modifyTime: 1767312000000,
      activityType: 56, timeZone: '+0800', activeTime: 1200, activitySummary: { syntheticMetric: { value: 12, unit: 'source_unit' } } }] };
}
export async function seedSyntheticIdentity(pg: PGlite, stageCount = 2) {
  const identity = { owner: randomUUID(), source: randomUUID(), token: randomBytes(32).toString('base64url') };
  await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [identity.owner]);
  await pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
    VALUES($1,$2,$3,$4,$5)`, [hash(identity.token), identity.owner, identity.source, ['sync', 'read', 'clear', 'revoke'], [...TYPES]]);
  const c = bindSyntheticDatabase(pg, identity);
  const activityBatch = syntheticActivityBatch(), sleepBatch = syntheticSleepBatch(stageCount);
  const activity = await c.request('trainingcamp/import', activityBatch), sleep = await c.request('trainingcamp/sleep/import', sleepBatch);
  if (activity.status !== 200 || sleep.status !== 200) throw new Error('synthetic fixture import failed');
  return { ...c, activityBatch, sleepBatch, activityReceipt: activity.body, sleepReceipt: sleep.body };
}
export async function createSyntheticFixture(stageCount = 2) {
  const pg = new PGlite();
  try {
    for (const name of migrations) await pg.exec(await readFile(new URL('../../migrations/' + name, import.meta.url), 'utf8'));
    return await seedSyntheticIdentity(pg, stageCount);
  } catch (error) { await pg.close(); throw error; }
}
