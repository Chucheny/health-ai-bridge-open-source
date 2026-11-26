import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runInNewContext } from 'node:vm';
import { readFileSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { collectSleepInPage } from '../../tools/trainingcamp-browser/collect-sleep.mjs';
import { verifyTrainingCampSleepCapture } from '../trainingcamp-capture.mts';

const selected = { startDay: '2026-01-01', endDay: '2026-01-02' };
const authorization = { start: '2026-01-01T00:00:00+08:00', end: '2026-01-03T00:00:00+08:00' };
const start = BigInt(Date.parse(authorization.start)) * 1000000n;
const stop = BigInt(Date.parse(authorization.end)) * 1000000n;
const session = (code = 1, delta = 0n) => ({ startTime: String(start + 1000000001n + delta),
  endTime: String(start + 5000000001n + delta), timeZone: '+0800',
  value: [{ fieldName: 'sleep_type', integerValue: code }, { fieldName: 'all_sleep_time', integerValue: 3 }],
  subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
    { startTime: String(start + 2000000001n + delta), endTime: String(start + 3000000001n + delta),
      value: [{ fieldName: 'sleep_stage', integerValue: 99 }] },
  ] } } });
const sourceRaw = () => JSON.stringify({ healthRecords: [session(1), session(3, 10000000000n)] })
  .replace(/"(\d{19})"/g, '$1'); // Synthetic raw JSON integer tokens, not rounded JS numbers.

async function collect(options: { raw?: string; status?: number; origin?: string; expiry?: string;
  request?: unknown; fail?: boolean; redirectUrl?: string; missingConfig?: boolean; wrongType?: boolean; extraStorage?: boolean } = {}) {
  const calls: { url: string; init: RequestInit }[] = [], storageReads: string[] = [];
  const token = 'synthetic-private-token-not-for-export';
  const context = { request: options.request ?? selected, URL, URLSearchParams, AbortController,
    TextDecoder, Uint8Array, Date, JSON, BigInt, Number, Math, Object, Array, String, Error,
    setTimeout, clearTimeout,
    location: { origin: options.origin ?? 'https://health.cloud.huawei.com', pathname: '/TrainingCamp' },
    sessionStorage: { getItem(key: string) {
      storageReads.push(key);
      return key === 'accessToken' ? token : key === 'expireTime' ? options.expiry ?? String(Date.now() + 60000) : null;
    } },
    window: options.missingConfig ? {} : { SYS_GLOBAL_CONFIG: { login: { viteClientId: 'synthetic-public-client' } },
      MAIN_CONFIG: { appVersion: 'synthetic-1.0' } },
    fetch: async (url: string, init: RequestInit) => {
      calls.push({ url, init });
      if (options.fail) throw new Error('private-exception-' + token);
      const response = new Response(options.raw ?? sourceRaw(), { status: options.status ?? 200,
        headers: { 'content-type': options.wrongType ? 'text/html' : 'application/json;charset=utf-8' } });
      Object.defineProperty(response, 'url', { value: options.redirectUrl ?? url });
      return response;
    },
  };
  const result = await runInNewContext('(' + collectSleepInPage.toString() + ')(request)', context);
  return { result: JSON.parse(JSON.stringify(result)), calls, storageReads, token };
}

test('reviewed page collector requests only the chosen sleep window and keeps credentials inside the Huawei page', async () => {
  const { result, calls, storageReads, token } = await collect();
  assert.equal(result.ok, true); assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(url.origin, 'https://hihealthbase-drcn.things.dbankcloud.cn');
  assert.equal(url.pathname, '/healthrunninggroup/v1/healthRecords');
  assert.equal(url.searchParams.get('startTime'), String(start));
  assert.equal(url.searchParams.get('endTime'), String(stop - 1n));
  assert.equal(url.searchParams.get('dataType'), 'com.huawei.health.record.sleep');
  assert.equal(url.searchParams.get('subDataType'), 'com.huawei.continuous.sleep.fragment');
  assert.equal(calls[0].init.method, 'GET'); assert.equal(calls[0].init.credentials, 'omit');
  assert.equal(calls[0].init.redirect, 'error'); assert.equal(calls[0].init.cache, 'no-store');
  assert.equal((calls[0].init.headers as Record<string, string>).Authorization, 'Bearer ' + token);
  assert.deepEqual(storageReads, ['accessToken', 'expireTime']);
  assert(!JSON.stringify(result).includes(token));
  assert(!JSON.stringify(result).includes('synthetic-public-client'));
  assert.equal(result.capture.rawResponse, sourceRaw());
  const verified = verifyTrainingCampSleepCapture(result.capture, authorization);
  assert.deepEqual(verified.counts, { sourceRecords: 2, mainSleepRecords: 1, napRecords: 1, unclassifiedRecords: 0 });
  assert.equal(verified.records[0].stages[0].startTimeNs, String(start + 2000000001n));
  assert.equal(verified.records[0].stages[0].stageKind, 'unknown');
  assert.equal(verified.liveReadingVerified, false); assert.equal(verified.sourceCompleteness, 'unknown');
});

test('wrong page, invalid calendar/range, expired login and changed page config never issue a network request', async () => {
  for (const options of [{ origin: 'https://unrelated.invalid' }, { expiry: '0' }, { missingConfig: true },
    { request: { startDay: '2026-02-30', endDay: '2026-03-02' } },
    { request: { startDay: selected.endDay, endDay: selected.startDay } },
    { request: { startDay: selected.startDay, endDay: '2026-03-01' } }]) {
    const { result, calls } = await collect(options);
    assert.equal(result.ok, false); assert.equal(calls.length, 0); assert.equal(result.capture, undefined);
  }
});

test('auth failures, rate limits, unexpected responses and redirects stop once without exposing server errors', async () => {
  for (const options of [{ status: 401 }, { status: 403 }, { status: 429 }, { status: 500 },
    { fail: true }, { wrongType: true }, { redirectUrl: 'https://unrelated.invalid/secret' },
    { raw: '{"healthRecords":[],"token":"synthetic-private-token-not-for-export"}' },
    { raw: '{"private_error":"private-sentinel"}' }]) {
    const { result, calls, token } = await collect(options);
    assert.equal(result.ok, false); assert.equal(calls.length, 1); assert.equal(result.capture, undefined);
    assert(!JSON.stringify(result).includes(token)); assert(!JSON.stringify(result).includes('private-sentinel'));
  }
});

test('out-of-window sessions, stages, known sleep-time fields and mixed data types reject the entire capture', async () => {
  const a = session();
  for (const record of [{ ...a, startTime: String(start - 1n) }, { ...a, endTime: String(stop + 1n) },
    { ...a, subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
      { startTime: String(start), endTime: String(start + 10n), value: [] },
    ] } } }, { ...a, value: [...a.value, { fieldName: 'wakeup_time', longValue: String(stop / 1000000n) }] },
    { ...a, dataType: 'com.huawei.unrelated' }, { ...a, subData: { unrelated: { samplePoints: [] } } }]) {
    const raw = JSON.stringify({ healthRecords: [session(), record] });
    const { result } = await collect({ raw });
    assert.equal(result.ok, false); assert.equal(result.capture, undefined);
  }
  const empty = await collect({ raw: '{"healthRecords":[]}' });
  assert.equal(empty.result.ok, true); assert.equal(empty.result.capture.sourceCompleteness, 'unknown');
  const huge = await collect({ raw: ' '.repeat(8 * 1024 * 1024 + 1) });
  assert.equal(huge.result.code, 'response_too_large'); assert.equal(huge.result.capture, undefined);
});

test('offline importer independently binds capture requests and every retained session/stage to authorization', async () => {
  const { result } = await collect(); const original = structuredClone(result.capture);
  for (const bad of [{ ...original, source: 'health_sync' }, { ...original, token: 'synthetic-secret' },
    { ...original, requestedWindow: { ...authorization, start: '2025-12-31T00:00:00+08:00' } },
    { ...original, apiRequest: { ...original.apiRequest, startTimeNs: String(start - 1n) } },
    { ...original, rawResponse: JSON.stringify({ healthRecords: [{ ...session(), startTime: String(start - 1n) }] }) },
    { ...original, rawResponse: '{"results":[],"groupResults":[]}' }]) {
    assert.throws(() => verifyTrainingCampSleepCapture(bad, authorization), /^Error: invalid_trainingcamp_capture$/);
  }
  const verified = verifyTrainingCampSleepCapture(original, authorization);
  assert.equal(verified.captureValidation.authorizedWindowEnforced, true);
  assert.deepEqual(result.capture, original);
  assert.throws(() => verifyTrainingCampSleepCapture(original, {
    start: '2026-01-02T00:00:00+08:00', end: authorization.end }), /^Error: invalid_trainingcamp_capture$/);
});

test('actual API dataTypeName on sessions and fragments cannot admit other health types', async () => {
  const { result: good } = await collect();
  const base = session();
  const wrongStage = { ...base, subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
    { ...base.subData['com.huawei.continuous.sleep.fragment'].samplePoints[0], dataTypeName: 'com.huawei.unrelated' },
  ] } } };
  for (const record of [{ ...base, dataTypeName: 'com.huawei.unrelated' }, wrongStage]) {
    const rawResponse = JSON.stringify({ healthRecords: [record] });
    assert.equal((await collect({ raw: rawResponse })).result.ok, false);
    assert.throws(() => verifyTrainingCampSleepCapture({ ...good.capture, rawResponse }, authorization),
      /^Error: invalid_trainingcamp_capture$/);
  }
});

test('capture CLI prints counts/validation only and extension requests no persistent host, storage or download access', async () => {
  const { result } = await collect();
  const cli = fileURLToPath(new URL('../trainingcamp-capture-diagnostic.mts', import.meta.url));
  const good = spawnSync(process.execPath, [cli, authorization.start, authorization.end], {
    input: JSON.stringify(result.capture), encoding: 'utf8',
  });
  assert.equal(good.status, 0); assert.equal(good.stderr, '');
  const output = JSON.parse(good.stdout);
  assert.equal(output.counts.napRecords, 1); assert.equal(output.liveReadingVerified, false);
  assert(!good.stdout.includes('rawResponse')); assert(!good.stdout.includes('sleep_stage'));
  const bad = spawnSync(process.execPath, [cli, authorization.start, authorization.end], { input: 'synthetic-secret', encoding: 'utf8' });
  assert.equal(bad.status, 1); assert.equal(bad.stdout, '');
  assert.deepEqual(JSON.parse(bad.stderr), { error: 'invalid_trainingcamp_capture' });
  const manifest = JSON.parse(readFileSync(new URL('../../tools/trainingcamp-browser/manifest.json', import.meta.url), 'utf8'));
  assert.deepEqual(manifest.permissions, ['activeTab', 'scripting']);
  assert.equal(manifest.host_permissions, undefined); assert.equal(manifest.content_scripts, undefined);
  assert.equal(manifest.background, undefined);
  assert.match(manifest.content_security_policy.extension_pages, /connect-src 'none'/);
});
