import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { PGlite } from '@electric-sql/pglite';
import { LATEST_PROTOCOL_VERSION } from '@modelcontextprotocol/sdk/types.js';
import { createHandler } from '../api.mts';
import type { Database, Sql } from '../database.mts';
import { createMcpHandler } from '../mcp.mts';
import { parseMcpSettings } from '../mcp-auth.mts';
import { hash, TYPES } from '../protocol.mts';
import { ensureRuntimeRole } from '../runtime-role.mts';
import { listSleepSnapshots, parseSleepUploadJob, prepareSleepUpload, sleepSnapshotMcpArgs, uploadSleepJob } from '../trainingcamp-sleep-client.mts';
import { parseTrainingCampQuery, trainingCampRecords } from '../trainingcamp-store.mts';
import { syntheticWorkoutSummary } from './support/trainingcamp-workout-fixture.mts';

// Synthetic only: no Huawei service, browser, health export, account configuration or remote DB.
const window = { start: '2026-01-01T00:00:00Z', end: '2026-01-03T00:00:00Z' };
function activity(id: string = randomUUID(), type: number | string = 56): any {
  return { id, activityType: type, startTime: Date.parse('2026-01-01T01:00:00Z'),
    endTime: Date.parse('2026-01-01T02:00:00Z'), modifyTime: Date.parse('2026-01-02T00:00:00Z'),
    activeTime: 3000, timeZone: '+0800', activitySummary: { dataSummary: [
      { fieldName: 'synthetic_source_metric', value: 12, unit: 'source_unit' },
    ] }, deviceInfo: { uniqueId: 'unrelated-private-sentinel' } };
}
function batch(records: unknown[]) {
  return { schemaVersion: 1, batchId: randomUUID(), source: 'huawei_trainingcamp', requestedWindow: window, records };
}
async function setup() {
  const pg = new PGlite();
  for (const file of ['001_health_bridge.sql', '002_trainingcamp_activities.sql', '003_trainingcamp_sleep.sql']) {
    await pg.exec(await readFile(new URL('../migrations/' + file, import.meta.url), 'utf8'));
  }
  const owner = randomUUID(), source = randomUUID(), token = randomBytes(32).toString('base64url');
  await pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [owner]);
  await pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
    VALUES($1,$2,$3,$4,$5)`, [hash(token), owner, source, ['sync', 'read', 'clear', 'revoke'], [...TYPES]]);
  let failReceipt = false, readonly = false;
  const db: Database = { transaction: fn => pg.transaction(async tx => {
    const result = await fn({ query: (sql, params) => {
      if (failReceipt && sql.startsWith('INSERT INTO health_bridge.sync_batches')) throw new Error('synthetic receipt failure');
      return tx.query<any>(sql, params);
    } });
    readonly = (await tx.query<any>("SELECT current_setting('transaction_read_only') AS value")).rows[0].value === 'on';
    return result;
  }) };
  const api = createHandler(db, undefined, { trainingCampEnabled: true });
  async function request(path: string, body?: unknown, credential = token, method?: string,
    useApi = api, headers: Record<string, string> = {}) {
    const response = await useApi(new Request('https://bridge.invalid/api/health/' + path, {
      method: method ?? (body === undefined ? 'GET' : 'POST'),
      headers: { authorization: 'Bearer ' + credential, 'content-type': 'application/json', ...headers },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    }));
    return { status: response.status, body: await response.json() as any, headers: response.headers };
  }
  const settings = parseMcpSettings({ resource: 'https://bridge.invalid/mcp', issuer: 'https://identity.invalid',
    jwksUrl: 'https://identity.invalid/jwks', subject: 'synthetic-user', clientId: 'synthetic-client',
    ownerId: owner, types: [...TYPES], readWindow: window, trainingCampEnabled: true });
  const mcp = createMcpHandler(db, settings, async value => value === 'synthetic-mcp-token');
  async function rpc(method: string, params: unknown, handler = mcp) {
    const response = await handler(new Request(settings.resource, { method: 'POST', headers: {
      authorization: 'Bearer synthetic-mcp-token', 'content-type': 'application/json',
      accept: 'application/json, text/event-stream', 'mcp-protocol-version': LATEST_PROTOCOL_VERSION,
    }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) }));
    return await response.json() as any;
  }
  async function call(name: string, args: Record<string, unknown>, handler = mcp) {
    return (await rpc('tools/call', { name, arguments: { ...window, type: 'ExerciseSessionRecord', ...args } }, handler)).result;
  }
  const query = (extra = '') => '?start=' + encodeURIComponent(window.start) + '&end=' + encodeURIComponent(window.end) +
    '&type=ExerciseSessionRecord&source=huawei_trainingcamp' + extra;
  return { pg, db, owner, source, token, settings, api, request, rpc, call, query,
    failReceipt: (value: boolean) => { failReceipt = value; }, readonly: () => readonly };
}

test('existing import/auth and real MCP tools read the new source separately from Health Sync and other owners', async () => {
  const c = await setup();
  try {
    const first = activity('same-external-id'), second = activity('indoor', 57);
    const imported = await c.request('trainingcamp/import', batch([first, second]));
    assert.equal(imported.status, 200); assert.equal(imported.body.changedRecords, 2);
    assert.match(imported.headers.get('cache-control')!, /no-store/);
    const oldRecord = { recordType: 'ExerciseSessionRecord', metadata: { id: first.id,
      dataOriginPackage: 'nl.appyhapps.healthsync', lastModifiedTime: '2026-01-02T00:00:00Z',
      clientRecordVersion: '0', recordingMethod: 0 }, startTime: '2026-01-01T01:00:00Z',
      endTime: '2026-01-01T02:00:00Z', startZoneOffset: '+08:00', endZoneOffset: '+08:00',
      exerciseType: 56, stages: undefined, segments: [], laps: [] };
    assert.equal((await c.request('sync', { schemaVersion: 1, batchId: randomUUID(), sequence: 1,
      recordType: 'ExerciseSessionRecord', operations: [{ op: 'upsert', record: oldRecord }] })).status, 200);
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync','read'],ARRAY['ExerciseSessionRecord'])`, [hash(otherToken), otherOwner, c.source]);
    assert.equal((await c.request('trainingcamp/import', batch([activity('other-owner-private')]), otherToken)).status, 200);
    const result = await c.call('health_records', { source: 'huawei_trainingcamp' });
    assert.notEqual(result.isError, true);
    const web = JSON.parse(result.content[0].text);
    assert.equal(c.readonly(), true); assert.equal(web.records.length, 2);
    assert.deepEqual(web.records.map((r: any) => r.record.category), ['outdoor_running', 'indoor_running']);
    assert.equal(web.records[0].record.sourceType, 56);
    assert.equal(web.records[0].record.startTimeMs, String(first.startTime));
    assert.equal(web.records[0].record.sourceModifiedTimeMs, String(first.modifyTime));
    assert.deepEqual(web.records[0].record.sourceSummary, first.activitySummary);
    assert.equal(web.records[0].record.activeTimeUnit, 'unverified');
    assert(!JSON.stringify(web).includes('other-owner-private'));
    assert(!JSON.stringify(web).includes('unrelated-private-sentinel'));
    assert.equal(web.availability.requiredSource, 'huawei_trainingcamp');
    assert.equal(web.availability.requiredOrigin, undefined);
    assert.equal(web.availability.crossSourceMerge, 'not_performed');
    const old = JSON.parse((await c.call('health_records', {})).content[0].text);
    assert.equal(old.records.length, 1); assert.equal(old.records[0].record.metadata.id, first.id);
    assert.equal(old.availability.requiredOrigin, 'nl.appyhapps.healthsync');
    const summary = JSON.parse((await c.call('health_summary', { source: 'huawei_trainingcamp' })).content[0].text);
    assert.equal(summary.bySource[0].records_count, '2'); assert.match(summary.metrics, /counts and time bounds/);
    assert.equal(summary.bySource[0].recordTimeBounds.earliestStart, '2026-01-01T01:00:00.000000000Z');
    assert.equal(summary.availability.sourceCompleteness, 'unknown');
  } finally { await c.pg.close(); }
});

test('imports are idempotent, keep stale versions out, reject same-version conflicts and never infer deletions', async () => {
  const c = await setup();
  try {
    const record = activity(), b = batch([record]);
    const first = await c.request('trainingcamp/import', b);
    assert.deepEqual((await c.request('trainingcamp/import', structuredClone(b))).body, first.body);
    assert.equal((await c.request('trainingcamp/import', batch([record]))).body.changedRecords, 0);
    const changed = { ...record, activityType: 97 };
    assert.equal((await c.request('trainingcamp/import', { ...b, records: [changed] })).body.error, 'batch_id_reused');
    assert.equal((await c.request('trainingcamp/import', batch([changed]))).body.error, 'source_version_conflict');
    assert.equal((await c.request('trainingcamp/import', batch([{ ...changed, modifyTime: record.modifyTime - 1 }]))).body.changedRecords, 0);
    assert.equal((await c.request('trainingcamp/import', batch([{ ...changed, modifyTime: record.modifyTime + 1 }]))).body.changedRecords, 1);
    assert.equal((await c.request('trainingcamp/import', batch([]))).body.deletionDetection, 'not_available');
    const out = await c.request('records' + c.query());
    assert.equal(out.body.records.length, 1); assert.equal(out.body.records[0].record.category, 'indoor_cycling');
    const count = (await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities')).rows[0].n;
    assert.equal(count, 1);
  } finally { await c.pg.close(); }
});

test('retained workout summaries expose per-exercise steps/HR through original REST/MCP without changing receipts, payloads or daily-data scope', async () => {
  const c = await setup();
  try {
    const record = activity('synthetic-metrics'); record.activitySummary = syntheticWorkoutSummary();
    const b = batch([record]), imported = await c.request('trainingcamp/import', b); assert.equal(imported.status, 200);
    const stored = await c.pg.query('SELECT payload,payload_hash FROM health_bridge.trainingcamp_activities');
    assert.equal((stored.rows[0] as any).payload.workoutMetrics, undefined, 'interpretation must not affect stored hashes');
    const rest = await c.request('records' + c.query()); assert.equal(rest.status, 200);
    const item = rest.body.records[0];
    assert.deepEqual(item.record.sourceSummary, record.activitySummary);
    assert.equal(item.workoutMetrics.steps.value, 2345);
    assert.equal(item.workoutMetrics.heartRate.average.value, 123.5);
    assert.equal(item.workoutMetrics.scope, 'exercise_session_only');
    const mcp = await c.call('health_records', { source: 'huawei_trainingcamp' }); assert.notEqual(mcp.isError, true);
    assert.deepEqual(JSON.parse(mcp.content[0].text).records[0].workoutMetrics, item.workoutMetrics);
    const overlap = await c.call('health_records', { source: 'huawei_trainingcamp',
      start: '2026-01-01T01:30:00Z', end: '2026-01-01T01:45:00Z' });
    const overlappingMetric = JSON.parse(overlap.content[0].text).records[0].workoutMetrics;
    assert.equal(overlappingMetric.timeScope, 'complete_activity_not_clipped_to_query');
    assert.equal(overlappingMetric.steps.value, 2345, 'partial overlap must not clip/prorate whole-exercise metrics');
    const tools = (await c.rpc('tools/list', {})).result.tools;
    assert(tools.every((tool: any) => tool.description.includes('not daily steps')));
    assert.deepEqual((await c.request('trainingcamp/import', b)).body, imported.body);
    assert.equal((await c.request('trainingcamp/import', batch([record]))).body.changedRecords, 0);
    assert.deepEqual(await c.pg.query('SELECT payload,payload_hash FROM health_bridge.trainingcamp_activities'), stored);
    // No silent projection into independent/day-wide StepsRecord or HeartRateRecord queries.
    for (const type of ['StepsRecord', 'HeartRateRecord', 'RestingHeartRateRecord']) {
      assert.equal((await c.request('records' + c.query().replace('ExerciseSessionRecord', type))).body.error,
        'trainingcamp_type_not_supported');
      assert.equal((await c.call('health_records', { source: 'huawei_trainingcamp', type })).content[0].text,
        'trainingcamp_type_not_supported');
    }
    assert.equal(JSON.parse((await c.call('health_records', { type: 'StepsRecord' })).content[0].text).records.length, 0);
    const narrow = createMcpHandler(c.db, { ...c.settings, readWindow: {
      start: '2026-01-01T01:30:00Z', end: window.end } }, async () => true);
    assert.equal(JSON.parse((await c.call('health_records', { source: 'huawei_trainingcamp',
      start: '2026-01-01T01:30:00Z' }, narrow)).content[0].text).records.length, 0);
    const noExerciseAccess = createMcpHandler(c.db, { ...c.settings, types: ['HeartRateRecord', 'StepsRecord'] }, async () => true);
    assert.equal((await c.call('health_records', { source: 'huawei_trainingcamp' }, noExerciseAccess)).content[0].text, 'forbidden');
    const summary = JSON.parse((await c.call('health_summary', { source: 'huawei_trainingcamp' })).content[0].text);
    assert.match(summary.metrics, /counts and time bounds/); assert.equal(summary.workoutMetrics, undefined);
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['HeartRateRecord','StepsRecord'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request('records' + c.query())).status, 403);
  } finally { await c.pg.close(); }
});

test('workout metrics are included in complete-record byte paging and preserve per-record missing/ambiguous states', async () => {
  const c = await setup();
  try {
    const first = activity('synthetic-present'), second = activity('synthetic-ambiguous'), third = activity('synthetic-absent');
    first.activitySummary = syntheticWorkoutSummary(); second.activitySummary = syntheticWorkoutSummary();
    second.activitySummary.dataSummary.push(structuredClone(second.activitySummary.dataSummary[0]));
    delete third.activitySummary;
    assert.equal((await c.request('trainingcamp/import', batch([first, second, third]))).status, 200);
    const principal = { owner: c.owner, source: c.source, tokenHash: hash(c.token), scopes: ['read'], types: ['ExerciseSessionRecord'] };
    const query = parseTrainingCampQuery(new URL('https://bridge.invalid/api/health/records' + c.query('&limit=3')));
    const all = await c.db.transaction(sql => trainingCampRecords(sql, principal, query));
    assert.deepEqual(all.records.map(r => r.workoutMetrics.steps.state), ['reported', 'ambiguous', 'not_reported']);
    assert.deepEqual(all.records.map(r => r.workoutMetrics.steps.value), [2345, null, null]);
    const firstBytes = Buffer.byteLength(JSON.stringify(all.records[0]));
    const rawBytes = Buffer.byteLength(JSON.stringify({ sourceId: all.records[0].sourceId,
      source: all.records[0].source, record: all.records[0].record }));
    assert(rawBytes < firstBytes - 1);
    await assert.rejects(c.db.transaction(sql => trainingCampRecords(sql, principal, query, firstBytes - 1)),
      error => error instanceof Error && error.message === 'record_exceeds_response_limit');
    const page = await c.db.transaction(sql => trainingCampRecords(sql, principal, query, firstBytes));
    assert.equal(page.records.length, 1); assert(page.nextCursor);
    const next = await c.request('records' + c.query('&limit=3&cursor=' + encodeURIComponent(page.nextCursor)));
    assert.equal(next.status, 200); assert.equal(next.body.records.length, 2);
    assert.equal(next.body.records[0].workoutMetrics.steps.state, 'ambiguous');
    assert.equal(next.body.records[1].workoutMetrics.steps.state, 'not_reported'); assert.equal(next.body.nextCursor, null);
  } finally { await c.pg.close(); }
});

test('failed receipt rolls back web records and identical retry works; revoked and type-restricted credentials stay denied', async () => {
  const c = await setup();
  try {
    const b = batch([activity()]); c.failReceipt(true);
    assert.equal((await c.request('trainingcamp/import', b)).status, 503); c.failReceipt(false);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities')).rows[0].n, 0);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.sync_batches')).rows[0].n, 0);
    assert.equal((await c.request('trainingcamp/import', b)).status, 200);
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['StepsRecord'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request('trainingcamp/import', batch([]))).status, 403);
    assert.equal((await c.request('records' + c.query())).status, 403);
    await c.pg.query('UPDATE health_bridge.device_tokens SET revoked_at=now() WHERE token_hash=$1', [hash(c.token)]);
    assert.equal((await c.request('trainingcamp/import', batch([]))).status, 401);
  } finally { await c.pg.close(); }
});

test('new source stays disabled by default and malformed, out-of-range or unrelated-type inputs never fall back', async () => {
  const c = await setup();
  try {
    const closed = createHandler(c.db);
    assert.equal((await c.request('trainingcamp/import', batch([]), c.token, undefined, closed)).status, 404);
    assert.equal((await c.request('records' + c.query(), undefined, c.token, undefined, closed)).body.error, 'source_not_enabled');
    const b = batch([activity()]);
    for (const bad of [{ ...b, ownerId: randomUUID() }, { ...b, authorization: 'synthetic-secret' },
      { ...b, source: 'nl.appyhapps.healthsync' }, { ...b, records: [activity(), { ...activity(), modifyTime: undefined }] },
      { ...b, records: [b.records[0], b.records[0]] },
      { ...b, records: [{ ...activity(), startTime: Date.parse(window.start) - 1 }] },
      { ...b, records: [{ ...activity(), endTime: Date.parse(window.end) + 1 }] },
      { ...b, requestedWindow: { ...window, end: '2026-03-01T00:00:00Z' } }]) {
      const denied = await c.request('trainingcamp/import', bad);
      assert.equal(denied.status, 400); assert.equal(denied.body.error, 'invalid_trainingcamp_import');
      assert(!JSON.stringify(denied.body).includes('synthetic-secret'));
    }
    assert.equal((await c.request('records' + c.query().replace('ExerciseSessionRecord', 'StepsRecord'))).body.error,
      'trainingcamp_type_not_supported');
    assert.equal((await c.request('records' + c.query('&origin=nl.appyhapps.healthsync'))).body.error, 'origin_not_allowed');
    assert.equal((await c.request('records' + c.query().replace('huawei_trainingcamp', 'unknown'))).body.error, 'invalid_source');
    const sleep = await c.call('health_records', { source: 'huawei_trainingcamp', type: 'StepsRecord' });
    assert.equal(sleep.content[0].text, 'trainingcamp_type_not_supported');
    const denied = await c.call('health_records', { source: 'huawei_trainingcamp', start: '2025-12-31T23:59:59Z' });
    assert.equal(denied.content[0].text, 'outside_authorized_window');
    const disabled = createMcpHandler(c.db, { ...c.settings, trainingCampEnabled: false }, async () => true);
    const tools = (await c.rpc('tools/list', {}, disabled)).result.tools;
    assert.deepEqual(tools.map((t: any) => t.name).sort(), ['health_records', 'health_summary']);
    assert(tools.every((t: any) => !t.inputSchema.properties.source));
    assert(tools.every((t: any) => !t.inputSchema.properties.sleepStages));
    assert.equal((await c.call('health_records', { source: 'huawei_trainingcamp' }, disabled)).isError, true);
  } finally { await c.pg.close(); }
});

function sleepCapture(types = [1, 3, 99]): any {
  const base = BigInt(Date.parse('2026-01-01T22:00:00Z')) * 1000000n + 123456n;
  return { schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'sleep', requestedWindow: window,
    capturedAt: '2026-01-03T00:00:00Z', sourceCompleteness: 'unknown',
    apiRequest: { startTimeNs: (BigInt(Date.parse(window.start)) * 1000000n).toString(),
      endTimeNs: (BigInt(Date.parse(window.end)) * 1000000n - 1n).toString() },
    rawResponse: JSON.stringify({ healthRecords: types.map((type, i) => {
      const start = base + BigInt(i) * 3600000000000n, end = start + 1800000000000n;
      return { id: 'repeated-source-id', dataTypeName: 'com.huawei.health.record.sleep',
        originalDataCollectorId: 'synthetic-collector', timeZone: '+0800',
        startTime: start.toString(), endTime: end.toString(), value: [
          { fieldName: 'sleep_type', integerValue: type }, { fieldName: 'all_sleep_time', integerValue: 25 },
        ], subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
          { startTime: start.toString(), endTime: end.toString(),
            dataTypeName: 'com.huawei.continuous.sleep.fragment', originalDataCollectorId: 'synthetic-stage-collector',
            value: [{ fieldName: 'stage', integerValue: i === 2 ? 99 : 3, syntheticExtra: 'retained' }] },
        ] } } };
    }) }) };
}
function sleepBatch(capture = sleepCapture()) {
  return { schemaVersion: 1, batchId: randomUUID(), source: 'huawei_trainingcamp', authorizedWindow: window, capture };
}
const sleepArgs = (snapshot: string) => ({ source: 'huawei_trainingcamp', type: 'SleepSessionRecord', snapshot });
const sleepQuery = (c: Awaited<ReturnType<typeof setup>>, snapshot: string, extra = '') =>
  c.query().replace('ExerciseSessionRecord', 'SleepSessionRecord') + '&snapshot=' + snapshot + extra;

test('local client round trip keeps one durable batch through a lost receipt, selects a catalog snapshot and calls original MCP', async () => {
  const c = await setup();
  try {
    const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['SleepSessionRecord'] };
    const job = parseSleepUploadJob(JSON.parse(JSON.stringify(prepareSleepUpload(sleepCapture(), window))));
    let attempts = 0;
    const transport: typeof fetch = async (url, init) => {
      const response = await c.api(new Request(url, init)); attempts++;
      if (attempts === 1) throw new Error('synthetic response lost after commit');
      return response;
    };
    await assert.rejects(uploadSleepJob(job, config, async () => false, transport), /upload_cancelled/); assert.equal(attempts, 0);
    await assert.rejects(uploadSleepJob(job, config, async () => true, transport), /bridge_outcome_unknown/); assert.equal(attempts, 1);
    const imported = await uploadSleepJob(job, config, async () => true, transport); assert.equal(attempts, 2);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_snapshots')).rows[0].n, 1);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.sync_batches')).rows[0].n, 1);
    const snapshots = await listSleepSnapshots(config, window, undefined, transport);
    assert.equal(snapshots.snapshots.length, 1); assert.equal(snapshots.snapshots[0].snapshotId, imported.snapshotId);
    assert.equal(snapshots.snapshots[0].sourceId, c.source); assert.equal(snapshots.snapshots[0].sessionCount, 3);
    const selected = sleepSnapshotMcpArgs(snapshots.snapshots[0]);
    const records = JSON.parse((await c.call('health_records', selected.health_records)).content[0].text);
    assert.equal(records.records[0].record.sleepKind, 'main_sleep'); assert(records.nextCursor);
    const summary = JSON.parse((await c.call('health_summary', selected.health_summary)).content[0].text);
    assert.equal(summary.bySource.length, 3); assert.equal(summary.sourcePolicy.snapshotId, imported.snapshotId);
  } finally { await c.pg.close(); }
});

test('snapshot catalog is bounded, owner-isolated, type-authorized and rollback-safe without exposing sessions', async () => {
  const c = await setup();
  try {
    for (const types of [[1], [3], []]) await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture(types)));
    const query = '?start=' + encodeURIComponent(window.start) + '&end=' + encodeURIComponent(window.end);
    const path = 'trainingcamp/sleep/snapshots';
    let cursor = '', ids = new Set<string>();
    do {
      const page = await c.request(path + query + '&limit=1' + (cursor ? '&cursor=' + cursor : ''));
      assert.equal(page.status, 200); assert.match(page.headers.get('cache-control')!, /no-store/);
      assert.equal(page.body.snapshots.length, 1); const snapshot = page.body.snapshots[0];
      assert(!ids.has(snapshot.snapshotId)); ids.add(snapshot.snapshotId);
      assert(!JSON.stringify(page.body).includes('repeated-source-id')); assert(!JSON.stringify(page.body).includes('stages'));
      assert.equal(snapshot.sourceCompleteness, 'unknown'); cursor = page.body.nextCursor ?? '';
      assert(ids.size <= 3);
    } while (cursor);
    assert.equal(ids.size, 3);
    const first = await c.request(path + query + '&limit=1');
    assert.equal((await c.request(path + query.replace('2026-01-01', '2026-01-02') + '&cursor=' + first.body.nextCursor)).body.error,
      'invalid_sleep_catalog_query');
    const narrow = await c.request(path + query.replace('2026-01-01', '2026-01-02'));
    assert.deepEqual(narrow.body.snapshots, []); // Entire declared request window must fit, not just a returned session.
    for (const suffix of ['', query + '&limit=21', query + '&limit=0', query + '&ownerId=' + c.owner,
      query + '&start=' + encodeURIComponent(window.start), query + '&cursor=bad',
      query.replace('2026-01-03', '2026-03-03')]) {
      assert.equal((await c.request(path + suffix)).body.error, 'invalid_sleep_catalog_query');
    }
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['read'],ARRAY['SleepSessionRecord'])`, [hash(otherToken), otherOwner, randomUUID()]);
    assert.deepEqual((await c.request(path + query, undefined, otherToken)).body.snapshots, []);
    assert.equal((await c.request(path + query + '&cursor=' + first.body.nextCursor, undefined, otherToken)).body.error, 'invalid_sleep_catalog_query');
    const closed = createHandler(c.db);
    assert.equal((await c.request(path + query, undefined, c.token, undefined, closed)).status, 404);
    const failed = createHandler({ transaction: fn => c.db.transaction(sql => fn({ query: async (text, params) => {
      if (text.startsWith('SELECT s.snapshot_id')) throw new Error('synthetic-private-query-failure');
      return sql.query(text, params);
    } })) }, undefined, { trainingCampEnabled: true });
    const fault = await c.request(path + query, undefined, c.token, undefined, failed);
    assert.equal(fault.status, 503); assert(!JSON.stringify(fault).includes('synthetic-private-query-failure'));
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['ExerciseSessionRecord'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request(path + query)).status, 403);
    await c.pg.query('UPDATE health_bridge.device_tokens SET revoked_at=now() WHERE token_hash=$1', [hash(c.token)]);
    assert.equal((await c.request(path + query)).status, 401);
  } finally { await c.pg.close(); }
});

function stagedCapture(count: number, extraBytes = 500): any {
  const capture = sleepCapture([1, 3, 99]), raw = JSON.parse(capture.rawResponse);
  const first = raw.healthRecords[0], start = BigInt(first.startTime), end = BigInt(first.endTime);
  const step = (end - start) / BigInt(Math.max(count, 1));
  first.subData['com.huawei.continuous.sleep.fragment'].samplePoints = Array.from({ length: count }, (_, i) => ({
    startTime: (start + BigInt(i) * step).toString(), endTime: (start + BigInt(i + 1) * step).toString(),
    dataTypeName: 'com.huawei.continuous.sleep.fragment', originalDataCollectorId: 'synthetic-stage-collector',
    value: [{ fieldName: 'stage', integerValue: i % 5 === 4 ? 99 : i % 4 + 1,
      syntheticIndex: i, syntheticExtra: 'x'.repeat(extraBytes) }],
  }));
  // Empty-but-provided and unavailable stages must remain distinguishable from partial pages.
  raw.healthRecords[1].subData['com.huawei.continuous.sleep.fragment'].samplePoints = [];
  delete raw.healthRecords[2].subData;
  capture.rawResponse = JSON.stringify(raw);
  return capture;
}

test('explicit stage paging reconstructs an oversized session exactly and does not count empty/missing stages as pages', async () => {
  const c = await setup();
  try {
    const capture = stagedCapture(450), imported = await c.request('trainingcamp/sleep/import', sleepBatch(capture));
    assert.equal(imported.status, 200);
    const snapshot = imported.body.snapshotId;
    assert.equal((await c.call('health_records', sleepArgs(snapshot))).content[0].text, 'record_exceeds_response_limit');
    const expected = JSON.parse(capture.rawResponse).healthRecords[0].subData['com.huawei.continuous.sleep.fragment'].samplePoints;
    const reassembled: any[] = [], sessionKeys = new Set<string>(); let cursor: string | undefined, pages = 0;
    do {
      const output = await c.call('health_records', { ...sleepArgs(snapshot), sleepStages: 'paged', limit: 20, ...(cursor ? { cursor } : {}) });
      assert.notEqual(output.isError, true);
      assert(Buffer.byteLength(output.content[0].text) <= 196608);
      const page = JSON.parse(output.content[0].text); assert.equal(page.records.length, 1);
      assert.equal(page.availability.resultScope, 'returned_session_fragment');
      const item = page.records[0]; sessionKeys.add(item.sessionKey);
      assert.equal(item.stagePage.returned, item.record.stages.length);
      assert(item.stagePage.returned <= 200);
      if (item.record.sleepKind === 'main_sleep') {
        assert.equal(item.stagePage.startIndex, reassembled.length);
        assert.equal(item.stagePage.total, 450);
        reassembled.push(...item.record.stages);
        assert.equal(item.stagePage.sessionComplete, reassembled.length === 450);
      } else {
        assert.equal(item.stagePage.startIndex, 0); assert.equal(item.stagePage.total, 0);
        assert.equal(item.stagePage.sessionComplete, true);
        assert.equal(item.record.stageDataState, item.record.sleepKind === 'nap' ? 'provided_empty' : 'not_provided');
      }
      cursor = page.nextCursor ?? undefined; pages++;
      assert(pages < 20, 'cursor must progress');
    } while (cursor);
    assert(pages >= 5); assert.equal(sessionKeys.size, 3); assert.equal(reassembled.length, expected.length);
    assert.deepEqual(reassembled.map(stage => [stage.startTimeNs, stage.endTimeNs, stage.fields,
      stage.sourceDataType, stage.sourceCollectorId]), expected.map((stage: any) => [
      stage.startTime, stage.endTime, stage.value, stage.dataTypeName, stage.originalDataCollectorId,
    ]));
    assert.equal(reassembled[4].stageKind, 'unknown');
    const summary = JSON.parse((await c.call('health_summary', sleepArgs(snapshot))).content[0].text);
    assert.deepEqual(summary.bySource.map((r: any) => r.records_count), ['1', '1', '1']);
    const rest = await c.request('records' + sleepQuery(c, snapshot, '&sleepStages=paged'));
    assert.equal(rest.status, 200); assert(rest.body.nextCursor);
    const follow = await c.request('records' + sleepQuery(c, snapshot, '&sleepStages=paged&cursor=' + encodeURIComponent(rest.body.nextCursor)));
    assert.equal(follow.body.records[0].stagePage.startIndex, rest.body.records[0].stagePage.returned);
  } finally { await c.pg.close(); }
});

test('stage cursors cannot cross mode, snapshot, time window, owner or type, and forged offsets never silently skip to another session', async () => {
  const c = await setup();
  try {
    const imported = await c.request('trainingcamp/sleep/import', sleepBatch(stagedCapture(230))), snapshot = imported.body.snapshotId;
    const args = { ...sleepArgs(snapshot), sleepStages: 'paged' };
    const page = JSON.parse((await c.call('health_records', args)).content[0].text);
    const nextCursor = page.nextCursor; assert(nextCursor);
    const decoded = JSON.parse(Buffer.from(nextCursor, 'base64url').toString()); assert(decoded.o > 0);
    for (const patch of [{ o: -1 }, { o: 20000 }, { o: '1' }, { o: 1.5 }, { o: 230 }, { a: '999999', o: 1 }, { a: '0', o: 1 }]) {
      const cursor = Buffer.from(JSON.stringify({ ...decoded, ...patch })).toString('base64url');
      assert.equal((await c.call('health_records', { ...args, cursor })).content[0].text, 'invalid_cursor');
    }
    assert.equal((await c.call('health_records', { ...sleepArgs(snapshot), cursor: nextCursor })).content[0].text, 'invalid_cursor');
    assert.equal((await c.call('health_records', { ...args, cursor: nextCursor, start: '2026-01-01T01:00:00Z' })).content[0].text, 'invalid_cursor');
    const other = await c.request('trainingcamp/sleep/import', sleepBatch(stagedCapture(231)));
    assert.equal((await c.call('health_records', { ...args, snapshot: other.body.snapshotId, cursor: nextCursor })).content[0].text, 'invalid_cursor');
    const small = await c.request('trainingcamp/sleep/import', sleepBatch());
    const completePage = JSON.parse((await c.call('health_records', { ...sleepArgs(small.body.snapshotId), limit: 1 })).content[0].text);
    assert.equal((await c.call('health_records', { ...sleepArgs(small.body.snapshotId), sleepStages: 'paged', cursor: completePage.nextCursor })).content[0].text, 'invalid_cursor');
    assert.equal((await c.call('health_records', { ...args, source: 'health_sync' })).content[0].text, 'snapshot_not_supported');
    assert.equal((await c.call('health_records', { ...args, type: 'ExerciseSessionRecord' })).content[0].text, 'sleep_stage_paging_not_supported');
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['read'],ARRAY['SleepSessionRecord'])`, [hash(otherToken), otherOwner, randomUUID()]);
    assert.equal((await c.request('records' + sleepQuery(c, snapshot, '&sleepStages=paged&cursor=' + nextCursor), undefined, otherToken)).body.error, 'sleep_snapshot_not_found');
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['ExerciseSessionRecord'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request('records' + sleepQuery(c, snapshot, '&sleepStages=paged'))).status, 403);
    const narrow = createMcpHandler(c.db, { ...c.settings, readWindow: { start: '2026-01-02T00:00:00Z', end: window.end } }, async () => true);
    const filtered = JSON.parse((await c.call('health_records', { ...args, start: '2026-01-02T00:00:00Z' }, narrow)).content[0].text);
    assert.equal(filtered.records.length, 1); assert.equal(filtered.records[0].record.sleepKind, 'unknown');
    const tools = (await c.rpc('tools/list', {})).result.tools;
    assert(tools.find((t: any) => t.name === 'health_records').inputSchema.properties.sleepStages);
    assert(!tools.find((t: any) => t.name === 'health_summary').inputSchema.properties.sleepStages);
    assert.equal((await c.call('health_summary', args)).isError, true);
    assert.equal((await c.request('summary' + sleepQuery(c, snapshot, '&sleepStages=paged'))).body.error, 'sleep_stage_paging_not_supported');
    assert.equal((await c.request('records' + c.query('&sleepStages=paged'))).body.error, 'sleep_stage_paging_not_supported');
    assert.equal((await c.request('records' + sleepQuery(c, snapshot, '&sleepStages=unknown'))).body.error, 'sleep_stage_paging_not_supported');
  } finally { await c.pg.close(); }
});

test('stage paging shrinks byte-heavy pages, keeps metadata and huge stages explicit, and handles empty snapshots', async () => {
  const c = await setup();
  try {
    const imported = await c.request('trainingcamp/sleep/import', sleepBatch(stagedCapture(90, 3000))), snapshot = imported.body.snapshotId;
    const page = JSON.parse((await c.call('health_records', { ...sleepArgs(snapshot), sleepStages: 'paged' })).content[0].text);
    assert(page.records[0].stagePage.returned > 0 && page.records[0].stagePage.returned < 90);
    assert.equal(page.records[0].stagePage.sessionComplete, false); assert(page.nextCursor);
    const hugeStage = await c.request('trainingcamp/sleep/import', sleepBatch(stagedCapture(1, 190 * 1024)));
    assert.equal((await c.call('health_records', { ...sleepArgs(hugeStage.body.snapshotId), sleepStages: 'paged' })).content[0].text,
      'sleep_stage_exceeds_response_limit');
    const largeMeta = sleepCapture([1]), raw = JSON.parse(largeMeta.rawResponse);
    raw.healthRecords[0].value[0].syntheticExtra = 'x'.repeat(190 * 1024); largeMeta.rawResponse = JSON.stringify(raw);
    const meta = await c.request('trainingcamp/sleep/import', sleepBatch(largeMeta));
    assert.equal((await c.call('health_records', { ...sleepArgs(meta.body.snapshotId), sleepStages: 'paged' })).content[0].text,
      'sleep_session_metadata_exceeds_response_limit');
    const empty = await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([])));
    const result = JSON.parse((await c.call('health_records', { ...sleepArgs(empty.body.snapshotId), sleepStages: 'paged' })).content[0].text);
    assert.deepEqual(result.records, []); assert.equal(result.nextCursor, null);
    assert.equal(result.availability.sourceCompleteness, 'unknown');
  } finally { await c.pg.close(); }
});

test('sleep capture imports through original REST and MCP without merging sessions, stages, snapshots or Health Sync', async () => {
  const c = await setup();
  try {
    const b = sleepBatch(), imported = await c.request('trainingcamp/sleep/import', b);
    assert.equal(imported.status, 200); assert.equal(imported.body.snapshotCreated, true);
    const snapshot = imported.body.snapshotId;
    assert.equal(imported.body.sourceVersion, 'unavailable');
    const first = JSON.parse((await c.call('health_records', { ...sleepArgs(snapshot), limit: 1 })).content[0].text);
    assert.equal(c.readonly(), true); assert.equal(first.records.length, 1); assert(first.nextCursor);
    const next = JSON.parse((await c.call('health_records', { ...sleepArgs(snapshot), cursor: first.nextCursor })).content[0].text);
    const records = [...first.records, ...next.records].map(r => r.record);
    assert.equal(next.nextCursor, null);
    assert.deepEqual(records.map(r => r.sleepKind), ['main_sleep', 'nap', 'unknown']);
    assert.deepEqual(records.map(r => r.sourceRecordId), Array(3).fill('repeated-source-id'));
    assert.equal(records[0].stages[0].startTimeNs, '1767304800000123456');
    assert.equal(records[2].stages[0].stageKind, 'unknown');
    assert.equal(records[0].stages[0].fields[0].syntheticExtra, 'retained');
    assert.equal(records[0].stages[0].sourceCollectorId, 'synthetic-stage-collector');
    assert.equal(first.sourcePolicy.snapshotSemantics, 'immutable_observation_not_latest');
    const rest = await c.request('records' + sleepQuery(c, snapshot));
    assert.equal(rest.status, 200); assert.equal(rest.body.records.length, 3);
    const summary = JSON.parse((await c.call('health_summary', sleepArgs(snapshot))).content[0].text);
    assert.deepEqual(summary.bySource.map((r: any) => [r.sleepKind, r.records_count]),
      [['main_sleep', '1'], ['nap', '1'], ['unknown', '1']]);
    assert.match(summary.metrics, /counts are not nights/);
    const old = JSON.parse((await c.call('health_records', { type: 'SleepSessionRecord' })).content[0].text);
    assert.equal(old.records.length, 0); assert.equal(old.availability.requiredOrigin, 'nl.appyhapps.healthsync');
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.health_records')).rows[0].n, 0);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.sync_streams')).rows[0].n, 0);
  } finally { await c.pg.close(); }
});

test('sleep imports reuse content observations, preserve changes and empty snapshots, and roll back failed receipts', async () => {
  const c = await setup();
  try {
    const b = sleepBatch(), first = await c.request('trainingcamp/sleep/import', b);
    assert.deepEqual((await c.request('trainingcamp/sleep/import', structuredClone(b))).body, first.body);
    const recollected = structuredClone(b.capture); recollected.capturedAt = '2026-01-04T00:00:00Z';
    const duplicate = await c.request('trainingcamp/sleep/import', sleepBatch(recollected));
    assert.equal(duplicate.body.snapshotId, first.body.snapshotId); assert.equal(duplicate.body.snapshotCreated, false);
    assert.equal((await c.request('trainingcamp/sleep/import', { ...b, capture: recollected })).body.error, 'batch_id_reused');
    const changed = await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([2])));
    assert.notEqual(changed.body.snapshotId, first.body.snapshotId);
    assert.equal((await c.request('records' + sleepQuery(c, first.body.snapshotId))).body.records.length, 3);
    const empty = await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([])));
    assert.equal(empty.body.deletionDetection, 'not_available');
    const emptyPage = JSON.parse((await c.call('health_records', sleepArgs(empty.body.snapshotId))).content[0].text);
    assert.equal(emptyPage.records.length, 0); assert.equal(emptyPage.availability.sourceCompleteness, 'unknown');
    const pending = sleepBatch(sleepCapture([3, 3])); c.failReceipt(true);
    assert.equal((await c.request('trainingcamp/sleep/import', pending)).status, 503); c.failReceipt(false);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_snapshots')).rows[0].n, 3);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records')).rows[0].n, 4);
    assert.equal((await c.request('trainingcamp/sleep/import', pending)).status, 200);
    // The shared receipt namespace cannot be reused between motion and sleep.
    assert.equal((await c.request('trainingcamp/import', { ...batch([]), batchId: b.batchId })).body.error, 'batch_id_reused');
  } finally { await c.pg.close(); }
});

test('sleep import enforces independent upload window, types, scopes and disabled feature without data leakage', async () => {
  const c = await setup();
  try {
    const b = sleepBatch(), closed = createHandler(c.db);
    assert.equal((await c.request('trainingcamp/sleep/import', b, c.token, undefined, closed)).status, 404);
    const wrongType = structuredClone(b.capture);
    const raw = JSON.parse(wrongType.rawResponse); raw.healthRecords[0].dataTypeName = 'com.huawei.health.heart_rate';
    wrongType.rawResponse = JSON.stringify(raw);
    const outsideStage = structuredClone(b.capture), outsideRaw = JSON.parse(outsideStage.rawResponse);
    outsideRaw.healthRecords[0].subData['com.huawei.continuous.sleep.fragment'].samplePoints[0].endTime = '9999999999999999999';
    outsideStage.rawResponse = JSON.stringify(outsideRaw);
    for (const bad of [{ ...b, ownerId: c.owner }, { ...b, authorization: 'synthetic-secret' },
      { ...b, authorizedWindow: { start: '2026-01-02T00:00:00Z', end: window.end } },
      sleepBatch(wrongType), sleepBatch(outsideStage)]) {
      const denied = await c.request('trainingcamp/sleep/import', bad);
      assert.equal(denied.status, 400); assert.equal(denied.body.error, 'invalid_trainingcamp_sleep_import');
      assert(!JSON.stringify(denied).includes('synthetic-secret'));
    }
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_snapshots')).rows[0].n, 0);
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['ExerciseSessionRecord'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request('trainingcamp/sleep/import', b)).status, 403);
    await c.pg.query("UPDATE health_bridge.device_tokens SET allowed_types=ARRAY['SleepSessionRecord'],scopes=ARRAY['read'] WHERE token_hash=$1", [hash(c.token)]);
    assert.equal((await c.request('trainingcamp/sleep/import', b)).status, 403);
    await c.pg.query('UPDATE health_bridge.device_tokens SET revoked_at=now() WHERE token_hash=$1', [hash(c.token)]);
    assert.equal((await c.request('trainingcamp/sleep/import', b)).status, 401);
  } finally { await c.pg.close(); }
});

test('sleep queries bind owner, snapshot, cursor, type and server authorization; oversized stages fail whole', async () => {
  const c = await setup();
  try {
    const imported = await c.request('trainingcamp/sleep/import', sleepBatch()), snapshot = imported.body.snapshotId;
    const changed = await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([3])));
    const page = JSON.parse((await c.call('health_records', { ...sleepArgs(snapshot), limit: 1 })).content[0].text);
    assert.equal((await c.call('health_records', { ...sleepArgs(changed.body.snapshotId), cursor: page.nextCursor })).content[0].text, 'invalid_cursor');
    assert.equal((await c.call('health_records', { ...sleepArgs(snapshot), cursor: page.nextCursor, start: '2026-01-01T01:00:00Z' })).content[0].text, 'invalid_cursor');
    assert.equal((await c.call('health_records', { source: 'huawei_trainingcamp', type: 'SleepSessionRecord' })).content[0].text, 'sleep_snapshot_required');
    assert.equal((await c.call('health_records', { ...sleepArgs(snapshot), source: 'health_sync' })).content[0].text, 'snapshot_not_supported');
    assert.equal((await c.call('health_records', { ...sleepArgs(snapshot), type: 'ExerciseSessionRecord' })).content[0].text, 'snapshot_not_supported');
    assert.equal((await c.call('health_records', sleepArgs(randomUUID()))).content[0].text, 'sleep_snapshot_not_found');
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync','read'],ARRAY['SleepSessionRecord'])`, [hash(otherToken), otherOwner, randomUUID()]);
    assert.equal((await c.request('records' + sleepQuery(c, snapshot), undefined, otherToken)).body.error, 'sleep_snapshot_not_found');
    const other = await c.request('trainingcamp/sleep/import', sleepBatch(), otherToken);
    assert.notEqual(other.body.snapshotId, snapshot);
    assert.equal((await c.call('health_records', sleepArgs(other.body.snapshotId))).content[0].text, 'sleep_snapshot_not_found');
    // Two installations for one owner retain independent observations, even with identical source IDs/content.
    const installationToken = randomBytes(32).toString('base64url');
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync','read'],ARRAY['SleepSessionRecord'])`, [hash(installationToken), c.owner, randomUUID()]);
    const installation = await c.request('trainingcamp/sleep/import', sleepBatch(), installationToken);
    assert.notEqual(installation.body.snapshotId, snapshot);
    const narrow = createMcpHandler(c.db, { ...c.settings, readWindow: { start: '2026-01-02T00:00:00Z', end: window.end } }, async () => true);
    const filtered = JSON.parse((await c.call('health_records', { ...sleepArgs(snapshot), start: '2026-01-02T00:00:00Z' }, narrow)).content[0].text);
    assert.equal(filtered.records.length, 1); assert.equal(filtered.records[0].record.sleepKind, 'unknown');
    const restricted = createMcpHandler(c.db, { ...c.settings, types: ['ExerciseSessionRecord'] }, async () => true);
    assert.equal((await c.call('health_records', sleepArgs(snapshot), restricted)).content[0].text, 'forbidden');
    const large = sleepCapture([1]), raw = JSON.parse(large.rawResponse);
    raw.healthRecords[0].subData['com.huawei.continuous.sleep.fragment'].samplePoints[0].value[0].extra = 'x'.repeat(190 * 1024);
    large.rawResponse = JSON.stringify(raw);
    const huge = await c.request('trainingcamp/sleep/import', sleepBatch(large)); assert.equal(huge.status, 200);
    assert.equal((await c.call('health_records', sleepArgs(huge.body.snapshotId))).content[0].text, 'record_exceeds_response_limit');
    assert.equal((await c.request('records' + sleepQuery(c, huge.body.snapshotId))).status, 413);
  } finally { await c.pg.close(); }
});

test('sleep tables enforce RLS and runtime immutability; clear cascades snapshots while feature is off', async () => {
  const c = await setup();
  try {
    await c.request('trainingcamp/sleep/import', sleepBatch());
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync','read'],ARRAY['SleepSessionRecord'])`, [hash(otherToken), otherOwner, randomUUID()]);
    await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([3])), otherToken);
    await ensureRuntimeRole({ query: (sql, params) => c.pg.query<any>(sql, params) }, 'a'.repeat(43));
    await c.pg.exec('SET ROLE health_bridge_runtime');
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records')).rows[0].n, 4);
    assert.equal((await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([2])))).status, 200);
    const runtimeRead = await c.request('trainingcamp/sleep/import', sleepBatch(sleepCapture([2])));
    assert.equal(runtimeRead.status, 200); assert.equal(runtimeRead.body.snapshotCreated, false);
    assert.equal((await c.request('records' + sleepQuery(c, runtimeRead.body.snapshotId))).body.records.length, 1);
    await assert.rejects(c.pg.exec("UPDATE health_bridge.trainingcamp_sleep_snapshots SET first_collected_at=now()"));
    await assert.rejects(c.pg.exec("UPDATE health_bridge.trainingcamp_sleep_records SET payload='{}'::jsonb"));
    // Actual clear through runtime permissions, retaining another owner's data and revoking credentials.
    const closed = createHandler(c.db);
    const cleared = await c.request('data', undefined, c.token, 'DELETE', closed,
      { 'x-confirm-clear': 'delete-all-my-cloud-health-data' });
    assert.equal(cleared.status, 200);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_snapshots')).rows[0].n, 1);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records')).rows[0].n, 1);
    assert.equal((await c.request('status')).status, 401);
    await c.pg.exec('RESET ROLE');
    await c.pg.exec(`CREATE ROLE sleep_synthetic_client; GRANT USAGE ON SCHEMA health_bridge TO sleep_synthetic_client;
      GRANT SELECT ON health_bridge.trainingcamp_sleep_snapshots,health_bridge.trainingcamp_sleep_records TO sleep_synthetic_client;
      SET ROLE sleep_synthetic_client`);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_snapshots')).rows[0].n, 0);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int n FROM health_bridge.trainingcamp_sleep_records')).rows[0].n, 0);
    await c.pg.exec('RESET ROLE');
  } finally { await c.pg.close(); }
});

test('new-source pages preserve complete records, bind cursors to source/window and enforce authorized record bounds', async () => {
  const c = await setup();
  try {
    assert.equal((await c.request('trainingcamp/import', batch([activity('a'), activity('b', 99999)]))).status, 200);
    const first = JSON.parse((await c.call('health_records', { source: 'huawei_trainingcamp', limit: 1 })).content[0].text);
    assert.equal(first.records.length, 1); assert(first.nextCursor);
    const next = JSON.parse((await c.call('health_records', { source: 'huawei_trainingcamp', limit: 1, cursor: first.nextCursor })).content[0].text);
    assert.equal(next.records[0].record.category, 'unknown'); assert.equal(next.nextCursor, null);
    assert.equal((await c.call('health_records', { cursor: first.nextCursor })).content[0].text, 'invalid_cursor');
    assert.equal((await c.call('health_records', { source: 'huawei_trainingcamp', cursor: first.nextCursor,
      start: '2026-01-01T01:00:00Z' })).content[0].text, 'invalid_cursor');
    // Broader stored record cannot leak through a narrower server-owned read window.
    const narrow = createMcpHandler(c.db, { ...c.settings, readWindow: {
      start: '2026-01-01T01:30:00Z', end: window.end } }, async () => true);
    const filtered = JSON.parse((await c.call('health_records', { source: 'huawei_trainingcamp',
      start: '2026-01-01T01:30:00Z' }, narrow)).content[0].text);
    assert.deepEqual(filtered.records, []); assert.equal(filtered.availability.fallbackUsed, false);
    // A huge complete record fails explicitly, never sliced into a misleading partial exercise.
    const huge = activity('large'); huge.activitySummary.dataSummary[0].large = 'x'.repeat(190 * 1024);
    assert.equal((await c.request('trainingcamp/import', batch([huge]))).status, 200);
    const page = JSON.parse((await c.call('health_records', { source: 'huawei_trainingcamp' })).content[0].text);
    assert.equal(page.records.length, 2); assert(page.nextCursor);
    const tooLarge = await c.call('health_records', { source: 'huawei_trainingcamp', cursor: page.nextCursor });
    assert.equal(tooLarge.content[0].text, 'record_exceeds_response_limit');
  } finally { await c.pg.close(); }
});

test('clear removes both sources after feature rollback and preserves other accounts', async () => {
  const c = await setup();
  try {
    assert.equal((await c.request('trainingcamp/import', batch([activity()]))).status, 200);
    const otherOwner = randomUUID(), otherToken = randomBytes(32).toString('base64url');
    await c.pg.query('INSERT INTO health_bridge.accounts(id) VALUES($1)', [otherOwner]);
    await c.pg.query(`INSERT INTO health_bridge.device_tokens(token_hash,owner_id,source_id,scopes,allowed_types)
      VALUES($1,$2,$3,ARRAY['sync'],ARRAY['ExerciseSessionRecord'])`, [hash(otherToken), otherOwner, randomUUID()]);
    await c.request('trainingcamp/import', batch([activity()]), otherToken);
    const disabled = createHandler(c.db);
    assert.equal((await c.request('data', undefined, c.token, 'DELETE', disabled)).body.error, 'confirmation_required');
    assert.equal((await c.request('data', undefined, c.token, 'DELETE', disabled,
      { 'x-confirm-clear': 'delete-all-my-cloud-health-data' })).status, 200);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities WHERE owner_id=$1', [c.owner])).rows[0].n, 0);
    assert.equal((await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities WHERE owner_id=$1', [otherOwner])).rows[0].n, 1);
    assert.equal((await c.request('status')).status, 401);
  } finally { await c.pg.close(); }
});

test('additive migration denies clients by RLS; operator runtime setup grants the new table without credential or DDL rights', async () => {
  const c = await setup();
  try {
    await c.request('trainingcamp/import', batch([activity()]));
    const adapter: Sql = { query: (sql, params) => c.pg.query<any>(sql, params) };
    await ensureRuntimeRole(adapter, 'a'.repeat(43));
    await ensureRuntimeRole(adapter, 'a'.repeat(43));
    await c.pg.exec('SET ROLE health_bridge_runtime');
    const n = (await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities')).rows[0].n;
    assert.equal(n, 1);
    await assert.rejects(c.pg.exec('CREATE TABLE health_bridge.forbidden_new_source(id int)'));
    await assert.rejects(c.pg.exec("UPDATE health_bridge.device_tokens SET scopes=ARRAY['clear']"));
    await c.pg.exec('RESET ROLE');
    await c.pg.exec('CREATE ROLE synthetic_client; GRANT USAGE ON SCHEMA health_bridge TO synthetic_client; GRANT SELECT ON health_bridge.trainingcamp_activities TO synthetic_client; SET ROLE synthetic_client');
    assert.equal((await c.pg.query<any>('SELECT count(*)::int AS n FROM health_bridge.trainingcamp_activities')).rows[0].n, 0);
    await c.pg.exec('RESET ROLE');
  } finally { await c.pg.close(); }
});
