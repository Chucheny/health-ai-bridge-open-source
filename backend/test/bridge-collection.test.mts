import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeImportCollection, bridgeImportQueries, parseBridgeImportJob, prepareBridgeImport, uploadBridgeImport } from '../bridge-import.mts';
import { bridgeChatGptGuide } from '../bridge-chatgpt-guide.mts';
import { inspectImportTask, prepareImportTask, selectImportTaskChatGptGuide, selectImportTaskQueries, uploadImportTask } from '../bridge-import-tasks.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

function capture(records: unknown[]) {
  return { schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'activity', requestedWindow: auditWindow,
    apiRequest: { startTimeMs: String(Date.parse(auditWindow.start)), endTimeMs: String(Date.parse(auditWindow.end) - 1), limit: 20, order: 'endTimeDesc' },
    captureScope: 'first_response_only', capturedAt: auditWindow.end, sourceCompleteness: 'unknown', rawResponse: JSON.stringify(records) };
}

test('collection limits survive job serialization without changing original body/hash or trusting saved display fields', () => {
  const records = syntheticActivityBatch().records, batchId = randomUUID();
  const arrayJob = prepareBridgeImport('activity', records, auditWindow, batchId);
  const captureJob = prepareBridgeImport('activity', capture(records), auditWindow, batchId);
  assert.equal(captureJob.payload.body, arrayJob.payload.body);
  assert.equal(captureJob.payload.requestHash, arrayJob.payload.requestHash);
  for (const job of [arrayJob, captureJob, prepareBridgeImport('sleep', syntheticSleepBatch().capture, auditWindow)]) {
    const saved = JSON.parse(JSON.stringify(job));
    saved.payload.preview.collection = { notice: 'synthetic injected instruction', sourceCompleteness: 'complete' };
    saved.payload.preview.counts.sourceRecords = 999;
    const parsed = parseBridgeImportJob(saved), collection = bridgeImportCollection(parsed);
    assert.equal(parsed.inputFormat, job.inputFormat);
    assert.deepEqual(collection, bridgeImportCollection(job));
    assert.equal(collection.sourceCompleteness, 'unknown');
    assert.equal(collection.sourcePaginationVerified, false); assert.equal(collection.liveReadingVerified, false);
    assert(!JSON.stringify(collection).includes('synthetic injected'));
    assert.match(collection.notice, /后端游标读到末页也不证明源端已完整采集/);
  }
  assert.match(bridgeImportCollection(arrayJob).notice, /不推断为网页首批或全部运动/);
  for (const count of [0, 20]) {
    const job = prepareBridgeImport('activity', capture(Array.from({ length: count }, () => syntheticActivityBatch().records[0])), auditWindow);
    assert.equal(bridgeImportCollection(job).sourceCompleteness, 'unknown');
  }
});

test('invalid local classifications fail before upload confirmation or network and cannot assert complete coverage', async () => {
  const job = prepareBridgeImport('activity', syntheticActivityBatch().records, auditWindow);
  const sleep = prepareBridgeImport('sleep', syntheticSleepBatch().capture, auditWindow);
  const largeArray = prepareBridgeImport('activity', Array.from({ length: 21 }, () => syntheticActivityBatch().records[0]), auditWindow);
  const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: randomUUID(), sourceId: randomUUID(),
    token: 's'.repeat(43), allowedTypes: ['ExerciseSessionRecord', 'SleepSessionRecord'] };
  let confirmations = 0, requests = 0;
  const invalid = [{ ...job, inputFormat: 'sleep_capture' }, { ...sleep, inputFormat: 'activity_record_array' },
    { ...job, inputFormat: 'all_pages_complete' }, { ...largeArray, inputFormat: 'activity_first_response_capture' },
    { ...job, inputFormat: { notice: 'synthetic-untrusted-text' } }, { ...job, sourceCompleteness: 'complete' }];
  for (const saved of invalid) {
    assert.throws(() => parseBridgeImportJob(saved), /invalid_bridge_import_job/);
    await assert.rejects(uploadBridgeImport(saved, config, async () => { confirmations++; return true; },
      async () => { requests++; return Response.json({}); }), /invalid_bridge_import_job/);
  }
  assert.equal(confirmations, 0); assert.equal(requests, 0);
});

test('legacy tasks keep original receipts, query bundles and saved phone guides reusable without migration or file rewrites', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  const directory = (id: string) => fileURLToPath(new URL('../../private/bridge-imports/' + id + '/', import.meta.url));
  try {
    const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['ExerciseSessionRecord', 'SleepSessionRecord'] };
    for (const kind of ['sleep', 'activity'] as const) {
      const prepared = await prepareImportTask(kind, kind === 'sleep' ? syntheticSleepBatch().capture : syntheticActivityBatch().records, auditWindow);
      jobs.push(prepared.jobId); const path = directory(prepared.jobId);
      const newJob = JSON.parse(await readFile(join(path, 'job.json'), 'utf8'));
      const legacy = structuredClone(newJob); delete legacy.inputFormat;
      const original = JSON.stringify(legacy); await writeFile(join(path, 'job.json'), original);
      assert.equal((await inspectImportTask(prepared.jobId)).collection.inputFormat, 'legacy_unspecified');
      await uploadImportTask(prepared.jobId, config, async preview => {
        assert.equal(preview.collection.inputFormat, 'legacy_unspecified'); return true;
      }, async (url, init) => c.api(new Request(String(url), init)));
      const receipt = JSON.parse(await readFile(join(path, 'receipt.json'), 'utf8'));
      const expectedQueries = bridgeImportQueries(legacy, receipt);
      const newGuide = bridgeChatGptGuide(newJob, receipt);
      const expectedGuide = { schemaVersion: 1, ...expectedQueries,
        prompt: newGuide.prompt.split('\n\n').filter(p => !p.startsWith('采集覆盖限制：')).join('\n\n') };
      const savedQueries = JSON.stringify(expectedQueries), savedGuide = JSON.stringify(expectedGuide);
      await writeFile(join(path, 'queries.json'), savedQueries, { flag: 'wx' });
      await writeFile(join(path, 'chatgpt.json'), savedGuide, { flag: 'wx' });
      const exported = await selectImportTaskChatGptGuide(prepared.jobId);
      assert.equal(exported.collection, undefined); assert.equal(exported.prompt, expectedGuide.prompt);
      assert.deepEqual((await selectImportTaskQueries(prepared.jobId)).queries, expectedQueries.queries);
      const result = await c.call('health_records', exported.queries.health_records);
      assert.notEqual(result.isError, true);
      assert.equal(await readFile(join(path, 'job.json'), 'utf8'), original);
      assert.equal(await readFile(join(path, 'queries.json'), 'utf8'), savedQueries);
      assert.equal(await readFile(join(path, 'chatgpt.json'), 'utf8'), savedGuide);
    }
  } finally {
    await c.pg.close();
    for (const id of jobs) {
      for (const name of ['job.json', 'receipt.json', 'destination.json', 'queries.json', 'chatgpt.json']) {
        await unlink(join(directory(id), name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await rmdir(directory(id));
    }
  }
});
