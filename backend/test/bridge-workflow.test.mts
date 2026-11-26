import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeFrameworkOverview } from '../bridge-sources.mts';
import { bridgeImportQueries, parseBridgeImportJob, prepareBridgeImport, uploadBridgeImport } from '../bridge-import.mts';
import { inspectImportTask, prepareImportTask, selectImportTaskQueries, uploadImportTask } from '../bridge-import-tasks.mts';
import { syntheticActivityBatch, syntheticSleepBatch, auditWindow, createSyntheticFixture } from './support/trainingcamp-fixture.mts';
import { syntheticWorkoutSummary } from './support/trainingcamp-workout-fixture.mts';

const cli = fileURLToPath(new URL('../bridge-command.mts', import.meta.url));
const directory = (id: string) => fileURLToPath(new URL('../../private/bridge-imports/' + id + '/', import.meta.url));
async function cleanup(id: string) {
  for (const name of ['queries.json', 'receipt.json', 'destination.json', 'job.json']) {
    await unlink(join(directory(id), name)).catch(error => { if (error.code !== 'ENOENT') throw error; });
  }
  await rmdir(directory(id)); // Only this run's known UUID directory, never recursively remove private/.
}

test('unified task lifecycle completes both sleep and activity through original REST/MCP and survives lost receipts', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner,
    sourceId: c.source, token: c.token, allowedTypes: ['SleepSessionRecord', 'ExerciseSessionRecord'] };
  let requests = 0, loseReceipt = false;
  const fetcher: typeof fetch = async (url, init) => {
    assert.equal(new URL(String(url)).origin, config.baseUrl); assert.equal(init?.redirect, 'error'); requests++;
    const response = await c.api(new Request(String(url), init));
    if (loseReceipt) { loseReceipt = false; assert.equal(response.status, 200); await response.body?.cancel(); throw new Error('synthetic lost receipt'); }
    return response;
  };
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const activity = syntheticActivityBatch().records; activity[0].activitySummary = syntheticWorkoutSummary();
      const input = kind === 'sleep' ? syntheticSleepBatch().capture : activity, original = structuredClone(input);
      const prepared = await prepareImportTask(kind, input, auditWindow); jobs.push(prepared.jobId);
      assert.equal(prepared.collection.inputFormat, kind === 'sleep' ? 'sleep_capture' : 'activity_record_array');
      assert.deepEqual((await inspectImportTask(prepared.jobId)).collection, prepared.collection);
      assert.equal((await inspectImportTask(prepared.jobId)).state, 'prepared');
      await assert.rejects(selectImportTaskQueries(prepared.jobId), /invalid_bridge_import_receipt/);
      const before = requests;
      await assert.rejects(uploadImportTask(prepared.jobId, config, async () => false, fetcher), /upload_cancelled/);
      assert.equal(requests, before); assert.equal((await inspectImportTask(prepared.jobId)).state, 'prepared');
      loseReceipt = true;
      await assert.rejects(uploadImportTask(prepared.jobId, config, async preview => {
        assert.equal(preview.kind, kind); assert(!JSON.stringify(preview).includes(config.token));
        assert.deepEqual(preview.collection, prepared.collection); return true;
      }, fetcher), /bridge_outcome_unknown/);
      const bound = await inspectImportTask(prepared.jobId);
      assert.equal(bound.state, 'bound_without_local_receipt');
      assert.equal(Object.hasOwn(bound, 'receiptSummary'), false);
      const committed = await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id');
      const saved = await uploadImportTask(prepared.jobId, config, async () => true, fetcher);
      assert.equal(saved.status, 'uploaded_receipt_saved');
      const inspected = spawnSync(process.execPath, [cli, 'inspect', prepared.jobId], { encoding: 'utf8', timeout: 10000 });
      assert.equal(inspected.status, 0, inspected.stderr);
      const report = JSON.parse(inspected.stdout);
      assert.equal(report.state, 'committed_receipt_saved');
      assert(!inspected.stdout.includes(config.token) && !inspected.stdout.includes('requestHash'));
      const commonReceipt = { committedAt: saved.receipt.committedAt, receivedRecords: saved.receipt.receivedRecords };
      assert.deepEqual(await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id'), committed);
      const bundle = await selectImportTaskQueries(prepared.jobId);
      assert.equal(bundle.status, 'query_arguments_saved_not_called');
      const recordResult = await c.call('health_records', bundle.queries.health_records);
      const summaryResult = await c.call('health_summary', bundle.queries.health_summary);
      assert.notEqual(recordResult.isError, true); assert.notEqual(summaryResult.isError, true);
      const records = JSON.parse(recordResult.content[0].text).records;
      if (kind === 'sleep') {
        assert.equal(bundle.querySemantics, 'explicit_task_receipt_snapshot');
        assert('snapshotId' in saved.receipt);
        assert.deepEqual(report.receiptSummary, { ...commonReceipt, snapshotId: saved.receipt.snapshotId,
          snapshotCreated: saved.receipt.snapshotCreated });
        const summary = JSON.parse(summaryResult.content[0].text);
        assert.equal(summary.sourcePolicy.snapshotId, report.receiptSummary.snapshotId);
        assert.equal(summary.bySource.reduce((total: number, row: { records_count: string }) => total + Number(row.records_count), 0),
          report.receiptSummary.receivedRecords);
        assert.equal((bundle.queries.health_records as any).snapshot, saved.receipt.snapshotId);
        assert(records.every((r: any) => r.stagePage.sessionComplete));
      } else {
        assert.equal(bundle.querySemantics, 'live_activity_window_not_batch_snapshot');
        assert('changedRecords' in saved.receipt);
        assert.deepEqual(report.receiptSummary, { ...commonReceipt, changedRecords: saved.receipt.changedRecords });
        assert(records.some((r: any) => r.workoutMetrics.steps.value === 2345));
        assert.equal((bundle.queries.health_records as any).snapshot, undefined);
      }
      const beforeChange = requests;
      await assert.rejects(uploadImportTask(prepared.jobId, { ...config, sourceId: randomUUID() }, async () => true, fetcher), /upload_destination_changed/);
      assert.equal(requests, beforeChange, 'another destination must be rejected before network');
      for (const name of ['job.json', 'destination.json', 'receipt.json', 'queries.json']) {
        assert(!(await readFile(join(directory(prepared.jobId), name), 'utf8')).includes(config.token));
      }
      assert.deepEqual(input, original);
    }
    // Original source remains independent; the framework never changes default queries to web data.
    const old = await c.call('health_records', { type: 'StepsRecord' }); assert.notEqual(old.isError, true);
    assert.equal(JSON.parse(old.content[0].text).availability.requiredOrigin, 'nl.appyhapps.healthsync');
  } finally { await c.pg.close(); for (const id of jobs) await cleanup(id); }
});

test('unified jobs enforce kinds, dates, byte/hash integrity, credential types and matching receipts before granting query readiness', async () => {
  const raw = syntheticActivityBatch().records;
  raw[0].deviceInfo = { syntheticPrivate: 'must-not-be-persisted' };
  const prepared = prepareBridgeImport('activity', raw, auditWindow);
  assert(!prepared.payload.body.includes('must-not-be-persisted'));
  const tampered = structuredClone(prepared); tampered.payload.preview.counts.sourceRecords = 99;
  assert.equal(parseBridgeImportJob(tampered).payload.preview.counts.sourceRecords, 1);
  assert.throws(() => parseBridgeImportJob({ ...prepared, payload: { ...prepared.payload, body: prepared.payload.body + ' ' } }), /invalid_bridge_import_job/);
  for (const kind of ['unknown', 'HeartRateRecord']) assert.throws(() => prepareBridgeImport(kind, raw, auditWindow), /invalid_bridge_import_job/);
  assert.throws(() => prepareBridgeImport('activity', raw, { start: '2026-01-02T00:00:00Z', end: auditWindow.end }), /invalid_bridge_import_job/);
  assert.throws(() => prepareBridgeImport('sleep', syntheticSleepBatch().capture, { start: '2026-01-02T00:00:00Z', end: auditWindow.end }), /invalid_bridge_import_job/);
  const huge = structuredClone(raw); huge[0].activitySummary = { syntheticExtra: 'x'.repeat(2 * 1024 * 1024) };
  assert.throws(() => prepareBridgeImport('activity', huge, auditWindow), /invalid_bridge_import_job/);
  for (const invalid of [NaN, Infinity, Number.MAX_SAFE_INTEGER + 1]) {
    const bad = structuredClone(raw); bad[0].activitySummary = { syntheticValue: invalid };
    assert.throws(() => prepareBridgeImport('activity', bad, auditWindow), /invalid_bridge_import_job/);
  }
  const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: randomUUID(), sourceId: randomUUID(),
    token: 's'.repeat(43), allowedTypes: ['SleepSessionRecord'] };
  let calls = 0, confirmations = 0;
  const fetcher: typeof fetch = async () => { calls++; return Response.json({}); };
  await assert.rejects(uploadBridgeImport(prepared, config, async () => { confirmations++; return true; }, fetcher), /invalid_bridge_client_config/);
  assert.equal(calls, 0); assert.equal(confirmations, 0);
  const activityConfig = { ...config, allowedTypes: ['ExerciseSessionRecord'] };
  for (const receipt of [{}, { batchId: prepared.payload.preview.batchId, source: 'huawei_trainingcamp', committed: true,
    committedAt: '2026-01-03T00:00:00Z', receivedRecords: 1, changedRecords: 2,
    sourceCompleteness: 'unknown', deletionDetection: 'not_available' }]) {
    await assert.rejects(uploadBridgeImport(prepared, activityConfig, async () => true, async () => Response.json(receipt)), /bridge_outcome_unknown/);
  }
  assert.throws(() => bridgeImportQueries(prepared, {}), /invalid_bridge_import_receipt/);
});

test('task inspection never treats damaged local receipts as committed or overwrites them to generate queries', async () => {
  const c = await createSyntheticFixture(); let id: string | undefined;
  try {
    id = (await prepareImportTask('activity', syntheticActivityBatch().records, auditWindow)).jobId;
    const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['ExerciseSessionRecord'] };
    await uploadImportTask(id, config, async () => true, async (url, init) => c.api(new Request(String(url), init)));
    const binding = join(directory(id), 'destination.json'), movedBinding = join(directory(id), 'test-binding.json');
    await rename(binding, movedBinding);
    try {
      const orphaned = await inspectImportTask(id);
      assert.equal(orphaned.state, 'local_state_inconsistent');
      assert.equal(Object.hasOwn(orphaned, 'receiptSummary'), false);
    } finally { await rename(movedBinding, binding); }
    const receiptPath = join(directory(id), 'receipt.json');
    const parsed = JSON.parse(await readFile(receiptPath, 'utf8'));
    await writeFile(receiptPath, JSON.stringify({ ...parsed, requestHash: '0'.repeat(64) }));
    const mismatched = await inspectImportTask(id);
    assert.equal(mismatched.state, 'local_receipt_invalid');
    assert.equal(Object.hasOwn(mismatched, 'receiptSummary'), false);
    await writeFile(receiptPath, 'synthetic-damaged-receipt');
    const damaged = await inspectImportTask(id);
    assert.equal(damaged.state, 'local_state_inconsistent');
    assert.equal(Object.hasOwn(damaged, 'receiptSummary'), false);
    await assert.rejects(selectImportTaskQueries(id));
    assert.equal(await readFile(join(directory(id), 'receipt.json'), 'utf8'), 'synthetic-damaged-receipt');
  } finally { await c.pg.close(); if (id) await cleanup(id); }
});

test('unified CLI is offline by default and refuses noninteractive upload before reading config', async () => {
  const overview = spawnSync(process.execPath, [cli], { encoding: 'utf8', timeout: 10000 });
  assert.equal(overview.status, 0); assert.deepEqual(JSON.parse(overview.stdout), bridgeFrameworkOverview());
  const denied = spawnSync(process.execPath, [cli, 'upload', randomUUID(), 'nonexistent-config'], { encoding: 'utf8', timeout: 10000 });
  assert.equal(denied.status, 1); assert.equal(JSON.parse(denied.stderr).error, 'interactive_terminal_required');
  assert.equal(denied.stdout, ''); assert(!denied.stderr.includes('nonexistent-config'));
});

test('unified CLI prepare preserves unsafe integer source digits and leaves its input untouched', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hab-framework-')), file = join(temporary, 'synthetic-activity.json');
  let id: string | undefined;
  try {
    const records = syntheticActivityBatch().records;
    records[0].activitySummary = { syntheticLong: 'replace-me' };
    const text = JSON.stringify(records).replace('"replace-me"', '9007199254740993123');
    await writeFile(file, text, { flag: 'wx' });
    const prepared = spawnSync(process.execPath, [cli, 'prepare', 'activity', file, auditWindow.start, auditWindow.end],
      { encoding: 'utf8', timeout: 10000 });
    assert.equal(prepared.status, 0, prepared.stderr); id = JSON.parse(prepared.stdout).jobId;
    const job = parseBridgeImportJob(JSON.parse(await readFile(join(directory(id!), 'job.json'), 'utf8')));
    assert.equal(JSON.parse(job.payload.body).records[0].activitySummary.syntheticLong, '9007199254740993123');
    assert.equal(await readFile(file, 'utf8'), text);
    const inspected = spawnSync(process.execPath, [cli, 'inspect', id!], { encoding: 'utf8', timeout: 10000 });
    assert.equal(inspected.status, 0); assert.equal(JSON.parse(inspected.stdout).state, 'prepared');
  } finally { if (id) await cleanup(id); await unlink(file); await rmdir(temporary); }
});
