import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFile, mkdtemp, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { collectTrainingCampInPage } from '../../tools/trainingcamp-browser/collect-sleep.mjs';
import { verifyTrainingCampActivityCapture } from '../trainingcamp-capture.mts';
import { inspectImportTask, selectImportTaskChatGptGuide, uploadImportTask } from '../bridge-import-tasks.mts';
import { parseBridgeImportJob, prepareBridgeImport } from '../bridge-import.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch } from './support/trainingcamp-fixture.mts';
import { syntheticWorkoutSummary } from './support/trainingcamp-workout-fixture.mts';

const selected = { kind: 'activity', startDay: '2026-01-02', endDay: '2026-01-02' };
const requestedWindow = { start: '2026-01-01T16:00:00.000Z', end: '2026-01-02T16:00:00.000Z' };
function activity() {
  const r = syntheticActivityBatch().records[0];
  r.startTime += 86400000; r.endTime += 86400000; r.activitySummary = syntheticWorkoutSummary();
  r.deviceInfo = { syntheticPrivate: 'not-for-new-task' }; return r;
}
function orderedActivities(offset: number, count: number) {
  return Array.from({ length: count }, (_, index) => {
    const position = offset + index;
    const endTime = Date.parse(requestedWindow.end) - (position + 1) * 60000;
    return { ...activity(), id: 'synthetic-scroll-' + position, startTime: endTime - 30000, endTime };
  });
}
async function collect(options: { request?: unknown; raw?: string; pages?: { raw: string; status?: number }[];
  status?: number; fail?: boolean; origin?: string;
  expiry?: string; wrongType?: boolean; responseUrl?: string; noPrecision?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], storage: string[] = [], token = 'synthetic-private-access-token';
  const context = { request: options.request ?? selected, URL, URLSearchParams, AbortController, TextDecoder, Uint8Array,
    Date, JSON: options.noPrecision ? { parse: (text: string, reviver: any) => JSON.parse(text, (k, v) => reviver(k, v)), stringify: JSON.stringify } : JSON,
    BigInt, Number, Math, Object, Array, Set, String, Error, setTimeout, clearTimeout,
    location: { origin: options.origin ?? 'https://health.cloud.huawei.com', pathname: '/TrainingCamp' },
    sessionStorage: { getItem(key: string) { storage.push(key); return key === 'accessToken' ? token : String(options.expiry ?? Date.now() + 60000); } },
    window: { SYS_GLOBAL_CONFIG: { login: { viteClientId: 'synthetic-public-client' } }, MAIN_CONFIG: { appVersion: 'synthetic-1.0' } },
    fetch: async (url: string, init: RequestInit) => {
      const page = options.pages?.[calls.length];
      calls.push({ url, init }); if (options.fail) throw new Error(token);
      if (options.pages && !page) throw new Error('received an unexpected request');
      const response = new Response(page?.raw ?? options.raw ?? JSON.stringify([activity()]), { status: page?.status ?? options.status ?? 200,
        headers: { 'content-type': options.wrongType ? 'text/html' : 'application/json' } });
      Object.defineProperty(response, 'url', { value: options.responseUrl ?? url }); return response;
    } };
  const result = await runInNewContext('(' + collectTrainingCampInPage.toString() + ')(request)', context);
  return { result: JSON.parse(JSON.stringify(result)), calls, storage, token };
}

test('serialized activity collector sends only the reviewed first-page query and independently importable millisecond capture', async () => {
  const { result, calls, storage, token } = await collect();
  assert.equal(result.ok, true); assert.equal(calls.length, 1); assert.deepEqual(storage, ['accessToken', 'expireTime']);
  const call = calls[0], url = new URL(call.url);
  assert.equal(url.href, 'https://hihealthbase-drcn.things.dbankcloud.cn/healthrunninggroup/v1/activityRecord:query');
  assert.equal(call.init.method, 'POST'); assert.equal(call.init.redirect, 'error'); assert.equal(call.init.credentials, 'omit');
  assert.equal(call.init.referrerPolicy, 'no-referrer'); assert.equal(call.init.cache, 'no-store');
  assert.deepEqual(JSON.parse(String(call.init.body)), { startTime: String(Date.parse(requestedWindow.start)),
    endTime: String(Date.parse(requestedWindow.end) - 1), limit: 20, filterList: [], order: 'endTimeDesc' });
  assert.equal((call.init.headers as any).Authorization, 'Bearer ' + token);
  assert.equal(call.init.signal!.aborted, true, 'request controller is released after completion');
  assert(!JSON.stringify(result).includes(token));
  const verified = verifyTrainingCampActivityCapture(result.capture, auditWindow);
  assert.deepEqual(verified.requestedWindow, requestedWindow);
  assert.equal(verified.captureScope, 'first_response_only'); assert.equal(verified.liveReadingVerified, false);
  assert.equal(verified.sourceCompleteness, 'unknown'); assert.equal(verified.counts.sourceRecords, 1);
  assert.deepEqual(prepareBridgeImport('activity', verified.records, verified.requestedWindow).payload.preview.requestedWindow, requestedWindow);
});

test('activity capture rejects wrong scope, stale login and invalid dates before requests; errors never produce partial or credential-bearing output', async () => {
  for (const options of [{ origin: 'https://unrelated.invalid' }, { expiry: '0' },
    { request: { ...selected, kind: 'all_health' } }, { request: { ...selected, startDay: '2026-02-30' } },
    { request: { ...selected, endDay: '2026-03-01' } }]) {
    const { result, calls } = await collect(options); assert.equal(result.ok, false); assert.equal(calls.length, 0);
  }
  for (const options of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 500 }, { fail: true },
    { wrongType: true }, { responseUrl: 'https://unrelated.invalid/' }, { raw: '{"records":[]}' },
    { raw: JSON.stringify(Array.from({ length: 21 }, activity)) }, { raw: ' '.repeat(8 * 1024 * 1024 + 1) },
    { raw: JSON.stringify([{ ...activity(), id: 'synthetic-private-access-token' }]).replace('synthetic-', '\\u0073ynthetic-') }]) {
    const { result, calls, token } = await collect(options); assert.equal(result.ok, false); assert.equal(calls.length, 1);
    assert.equal(result.capture, undefined); assert(!JSON.stringify(result).includes(token));
  }
});

test('browser and offline activity validation reject out-of-window, duplicates, missing versions and altered request metadata without truncation', async () => {
  const original = (await collect()).result.capture;
  const r = activity();
  for (const records of [[r, { ...r }], [{ ...r, id: '' }], [{ ...r, modifyTime: undefined }],
    [{ ...r, startTime: Date.parse(requestedWindow.start) - 1 }], [{ ...r, endTime: Date.parse(requestedWindow.end) + 1 }],
    [{ ...r, activityType: -1 }], [{ ...r, activitySummary: [] }], [{ ...r, activeTime: -1 }]]) {
    const raw = JSON.stringify(records); assert.equal((await collect({ raw })).result.ok, false);
    assert.throws(() => verifyTrainingCampActivityCapture({ ...original, rawResponse: raw }, auditWindow), /invalid_trainingcamp_activity_capture/);
  }
  for (const bad of [{ ...original, sourceCompleteness: 'complete' }, { ...original, captureScope: 'all_pages' },
    { ...original, token: 'synthetic-secret' }, { ...original, kind: 'sleep' },
    { ...original, apiRequest: { ...original.apiRequest, limit: 100 } },
    { ...original, apiRequest: { ...original.apiRequest, startTimeMs: String(Date.parse(requestedWindow.start) - 1) } },
    { ...original, apiRequest: { ...original.apiRequest, endTimeMs: String(Date.parse(requestedWindow.end)) } }]) {
    assert.throws(() => verifyTrainingCampActivityCapture(bad, auditWindow), /invalid_trainingcamp_activity_capture/);
    assert.throws(() => prepareBridgeImport('activity', bad, auditWindow), /invalid_bridge_import_job/);
  }
  assert.throws(() => verifyTrainingCampActivityCapture(original, { ...auditWindow, start: '2026-01-02T00:00:00Z' }), /invalid_trainingcamp_activity_capture/);
  for (const count of [0, 20]) {
    const { result, calls } = await collect({ raw: JSON.stringify(Array.from({ length: count }, activity)) });
    assert.equal(result.ok, true); assert.equal(calls.length, 1);
    assert.equal(verifyTrainingCampActivityCapture(result.capture, auditWindow).counts.sourceRecords, count);
    assert.equal(result.capture.sourceCompleteness, 'unknown', 'empty or full pages never prove source coverage');
  }
});

test('activity capture preserves unsafe summary integer digits and refuses a parser that cannot preserve them', async () => {
  const raw = JSON.stringify([{ ...activity(), activitySummary: { syntheticLarge: 'replace-me' } }]).replace('"replace-me"', '9007199254740993123');
  const { result } = await collect({ raw }); assert.equal(result.ok, true); assert.equal(result.capture.rawResponse, raw);
  const job = prepareBridgeImport('activity', result.capture, auditWindow);
  assert.equal(JSON.parse(job.payload.body).records[0].activitySummary.syntheticLarge, '9007199254740993123');
  assert(!job.payload.body.includes('not-for-new-task'));
  assert.equal((await collect({ raw, noPrecision: true })).result.ok, false);
});

test('bounded activity scroll replays the webpage boundary through five full pages and rejects altered page chains offline', async () => {
  const records = orderedActivities(0, 100);
  const pages = Array.from({ length: 5 }, (_, index) => ({ raw: JSON.stringify(records.slice(index * 20, (index + 1) * 20)) }));
  const { result, calls } = await collect({ request: { ...selected, scroll: true }, pages });
  assert.equal(result.ok, true); assert.equal(result.sourceRecords, 100); assert.equal(calls.length, 5);
  for (const [index, call] of calls.entries()) {
    const end = index === 0 ? Date.parse(requestedWindow.end) - 1 : records[index * 20 - 1].startTime;
    assert.deepEqual(JSON.parse(String(call.init.body)), { startTime: String(Date.parse(requestedWindow.start)),
      endTime: String(end), limit: 20, filterList: [], order: 'endTimeDesc' });
    assert.deepEqual(result.capture.pages[index], { endTimeMs: String(end), rawResponse: pages[index].raw });
  }
  const verified = verifyTrainingCampActivityCapture(result.capture, auditWindow);
  assert.equal(verified.captureScope, 'bounded_scroll'); assert.equal(verified.sourceCompleteness, 'unknown');
  assert.deepEqual(verified.records, records);
  const observed = result.capture.pages;
  for (const altered of [
    observed.slice(0, -1),
    [...observed, observed[4]],
    [observed[0], { ...observed[1], endTimeMs: observed[0].endTimeMs }, ...observed.slice(2)],
    [{ ...observed[0], rawResponse: '[]' }, ...observed.slice(1)],
    [{ ...observed[0], rawResponse: JSON.stringify(records.slice(0, 20).reverse()) }, ...observed.slice(1)],
    [observed[0], { ...observed[1], rawResponse: observed[0].rawResponse }, ...observed.slice(2)],
  ]) assert.throws(() => verifyTrainingCampActivityCapture({ ...result.capture, pages: altered }, auditWindow),
    /invalid_trainingcamp_activity_capture/);
});

test('bounded activity scroll stops on empty or saturated date boundary and returns no capture after a failed or stalled page', async () => {
  const request = { ...selected, scroll: true };
  const firstPage = orderedActivities(0, 20);
  const first = { raw: JSON.stringify(firstPage) };
  const empty = await collect({ request, pages: [first, { raw: '[]' }] });
  assert.equal(empty.result.ok, true); assert.equal(empty.calls.length, 2);
  assert.equal(verifyTrainingCampActivityCapture(empty.result.capture, auditWindow).counts.sourceRecords, 20);
  const boundary = { ...firstPage[19], startTime: Date.parse(requestedWindow.start) };
  const atStart = await collect({ request, pages: [{ raw: JSON.stringify([...firstPage.slice(0, 19), boundary]) }] });
  assert.equal(atStart.result.ok, true); assert.equal(atStart.calls.length, 1);
  assert.equal(verifyTrainingCampActivityCapture(atStart.result.capture, auditWindow).counts.sourceRecords, 20);
  const outsidePage = { ...firstPage[19], id: 'synthetic-outside-page', startTime: firstPage[19].startTime + 1 };
  const outsidePageRaw = JSON.stringify([outsidePage]);
  const [firstMetadata, nextMetadata] = empty.result.capture.pages;
  assert.throws(() => verifyTrainingCampActivityCapture({ ...empty.result.capture,
    pages: [firstMetadata, { ...nextMetadata, rawResponse: outsidePageRaw }] }, auditWindow), /invalid_trainingcamp_activity_capture/);
  const stalled = orderedActivities(20, 20).map(record => ({ ...record, startTime: firstPage[19].startTime,
    endTime: firstPage[19].endTime }));
  for (const next of [first, { raw: '[]', status: 429 }, { raw: JSON.stringify(stalled) },
    { raw: outsidePageRaw }, { raw: JSON.stringify(orderedActivities(20, 2).reverse()) }]) {
    const { result, calls } = await collect({ request, pages: [first, next] });
    assert.equal(result.ok, false); assert.equal(result.capture, undefined); assert.equal(calls.length, 2);
  }
});

for (const scroll of [false, true]) test(`saved activity ${scroll ? 'scroll' : 'first response'} reaches original CLI/task/REST/receipt/phone-guide/MCP`, async () => {
  const c = await createSyntheticFixture(), temporary = await mkdtemp(join(tmpdir(), 'hab-activity-capture-'));
  const file = join(temporary, 'synthetic-capture.json'); let id: string | undefined;
  const taskDirectory = () => fileURLToPath(new URL('../../private/bridge-imports/' + id + '/', import.meta.url));
  try {
    const expected = scroll ? orderedActivities(0, 26) : [activity()];
    const pages = (scroll ? [expected.slice(0, 20), expected.slice(20)] : [expected])
      .map(records => ({ raw: JSON.stringify(records) }));
    const capture = (await collect({ request: { ...selected, scroll }, pages })).result.capture;
    const source = JSON.stringify(capture);
    await writeFile(file, source, { flag: 'wx' });
    const cli = fileURLToPath(new URL('../bridge-command.mts', import.meta.url));
    const prepared = spawnSync(process.execPath, [cli, 'prepare', 'activity', file, auditWindow.start, auditWindow.end], { encoding: 'utf8', timeout: 10000 });
    assert.equal(prepared.status, 0, prepared.stderr); id = JSON.parse(prepared.stdout).jobId;
    const collection = JSON.parse(prepared.stdout).collection;
    assert.equal(collection.inputFormat, scroll ? 'activity_bounded_scroll_capture' : 'activity_first_response_capture');
    const notice = scroll ? /最多请求5页、接收100条/ : /最多20条、未翻页/;
    assert.match(collection.notice, notice);
    assert.deepEqual((await inspectImportTask(id!)).preview.requestedWindow, requestedWindow, 'task scope follows the capture, never broadens to authorization');
    assert.deepEqual((await inspectImportTask(id!)).collection, collection);
    const job = parseBridgeImportJob(JSON.parse(await readFile(join(taskDirectory(), 'job.json'), 'utf8')));
    assert(!job.payload.body.includes('not-for-new-task')); assert(!job.payload.body.includes('rawResponse'));
    assert(!job.payload.body.includes('inputFormat'), 'local classification must not alter original upload protocol');
    await uploadImportTask(id!, { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['ExerciseSessionRecord'] }, async preview => {
        assert.deepEqual(preview.collection, collection); return true;
      }, async (url, init) => c.api(new Request(String(url), init)));
    const guide = await selectImportTaskChatGptGuide(id!);
    assert.deepEqual(guide.collection, collection); assert.match(guide.prompt, notice);
    assert.match(guide.prompt, /后端游标读到末页也不证明源端已完整采集/);
    const records = [];
    let cursor: string | null = null;
    for (let index = 0; index < (scroll ? 4 : 1); index++) {
      const response = await c.call('health_records', { ...guide.queries.health_records, limit: 7, ...(cursor ? { cursor } : {}) });
      assert.notEqual(response.isError, true);
      const page = JSON.parse(response.content[0].text);
      records.push(...page.records);
      cursor = page.nextCursor;
      assert.equal(cursor === null, index === (scroll ? 3 : 0));
    }
    assert.deepEqual(records.map(record => record.record.sourceRecordId), expected.map(record => record.id));
    assert.equal(records[0].workoutMetrics.steps.value, 2345);
    assert.equal(await readFile(file, 'utf8'), source);
    assert.equal((await inspectImportTask(id!)).state, 'committed_receipt_saved');
  } finally {
    await c.pg.close();
    if (id) { for (const name of ['chatgpt.json', 'receipt.json', 'destination.json', 'job.json']) await unlink(join(taskDirectory(), name)); await rmdir(taskDirectory()); }
    await unlink(file); await rmdir(temporary);
  }
});
