import { before, test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { previewBridgeImport } from '../bridge-import.mts';
import { inspectImportTask, selectImportTaskChatGptGuide, uploadImportTask } from '../bridge-import-tasks.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const cli = fileURLToPath(new URL('../bridge-command.mts', import.meta.url));
const tasks = fileURLToPath(new URL('../../private/bridge-imports/', import.meta.url));
const marker = 'synthetic-source-text-must-not-appear-in-preview';
before(() => mkdir(new URL('../../.tools/', import.meta.url), { recursive: true }));
async function ids() { return readdir(tasks).catch(e => { if (e.code === 'ENOENT') return []; throw e; }); }
function capture(records: unknown[], window = auditWindow) {
  return { schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'activity', requestedWindow: window,
    apiRequest: { startTimeMs: String(Date.parse(window.start)), endTimeMs: String(Date.parse(window.end) - 1), limit: 20, order: 'endTimeDesc' },
    captureScope: 'first_response_only', capturedAt: window.end, sourceCompleteness: 'unknown', rawResponse: JSON.stringify(records) };
}
function command(action: string, kind: string, file: string, extra: string[] = []) {
  return spawnSync(process.execPath, [cli, action, kind, file, auditWindow.start, auditWindow.end, ...extra], { encoding: 'utf8', timeout: 10000 });
}

test('multiple exercise captures preview and create one task with over 20 records, including a shared overnight exercise only once', async () => {
  const c = await createSyntheticFixture();
  const temporary = await mkdtemp(fileURLToPath(new URL('../../.tools/bridge-preview-', import.meta.url)));
  const files = [join(temporary, '合成 运动一.json'), join(temporary, '合成 运动二.json')];
  const first = { start: auditWindow.start, end: '2026-01-02T02:00:00Z' };
  const second = { start: '2026-01-01T22:00:00Z', end: auditWindow.end };
  const exercise = (start: string, finish: string) => ({
    ...syntheticActivityBatch().records[0], startTime: Date.parse(start), endTime: Date.parse(finish), modifyTime: Date.parse(finish),
  });
  const common = exercise('2026-01-01T23:00:00Z', '2026-01-02T01:00:00Z');
  const early = Array.from({ length: 19 }, () => exercise('2026-01-01T10:00:00Z', '2026-01-01T11:00:00Z'));
  const later = Array.from({ length: 11 }, () => exercise('2026-01-02T10:00:00Z', '2026-01-02T11:00:00Z'));
  const inputs = [JSON.stringify(capture([...early, common], first)),
    JSON.stringify(capture([{ ...common, deviceInfo: { ignored: marker } }, ...later], second))];
  const run = (action: string) => spawnSync(process.execPath, [cli, action, 'activity', '--captures', ...files.slice().reverse(),
    '2025-12-31T00:00:00Z', '2026-01-04T00:00:00Z'], { encoding: 'utf8', timeout: 10000 });
  let jobId: string | undefined;
  try {
    for (const [index, file] of files.entries()) await writeFile(file, inputs[index], { flag: 'wx' });
    const before = await ids(), preview = run('preview');
    assert.equal(preview.status, 0, preview.stderr);
    const report = JSON.parse(preview.stdout);
    assert.equal(report.status, 'validated_locally_no_task_created');
    assert.equal(report.counts.sourceRecords, 31);
    assert.deepEqual(report.requestedWindow, auditWindow);
    assert.equal(report.collection.inputFormat, 'activity_first_response_set');
    assert.equal(report.collection.sourceCompleteness, 'unknown');
    assert.equal(report.collection.sourcePaginationVerified, false);
    assert.deepEqual(await ids(), before);
    assert(!preview.stdout.includes(common.id) && !preview.stdout.includes(temporary));
    await writeFile(files[1], JSON.stringify(capture([{ ...common, modifyTime: common.modifyTime + 1 }, ...later], second)));
    const rejected = run('prepare');
    assert.equal(rejected.status, 1);
    assert.equal(JSON.parse(rejected.stderr).error, 'invalid_activity_capture_set');
    assert.deepEqual(await ids(), before);
    await writeFile(files[1], inputs[1]);
    const created = run('prepare');
    assert.equal(created.status, 0, created.stderr);
    jobId = JSON.parse(created.stdout).jobId; assert(jobId);
    const inspected = await inspectImportTask(jobId);
    assert.deepEqual(inspected.collection, report.collection);
    const job = JSON.parse(await readFile(join(tasks, jobId, 'job.json'), 'utf8'));
    const records = JSON.parse(job.payload.body).records;
    assert.equal(records.filter((record: { id: string }) => record.id === common.id).length, 1);
    assert(!job.payload.body.includes(marker) && !job.payload.body.includes(temporary));
    const uploaded = await uploadImportTask(jobId, { schemaVersion: 1, baseUrl: 'https://bridge.invalid',
      ownerId: c.owner, sourceId: c.source, token: c.token, allowedTypes: ['ExerciseSessionRecord'] }, async summary => {
      assert.deepEqual(summary.collection, report.collection);
      return true;
    }, async (url, init) => c.api(new Request(String(url), init)));
    assert.equal(uploaded.receipt.receivedRecords, 31);
    const guide = await selectImportTaskChatGptGuide(jobId);
    assert.match(guide.prompt, /多个网页运动首批文件/);
    assert.deepEqual(guide.collection, report.collection);
    const summary = await c.call('health_summary', guide.queries.health_summary);
    assert.notEqual(summary.isError, true);
    let cursor: string | null = null, pages = 0;
    const readIds: string[] = [];
    do {
      const query = await c.call('health_records', { ...guide.queries.health_records, ...(cursor ? { cursor } : {}) });
      assert.notEqual(query.isError, true);
      const response = JSON.parse(query.content[0].text);
      for (const item of response.records) readIds.push(item.record.sourceRecordId);
      cursor = response.nextCursor;
      assert(++pages < 10);
    } while (cursor !== null);
    for (const record of [...early, common, ...later]) assert.equal(readIds.filter(id => id === record.id).length, 1);
    for (const [index, file] of files.entries()) assert.equal(await readFile(file, 'utf8'), inputs[index]);
  } finally {
    await c.pg.close();
    if (jobId) {
      for (const name of ['job.json', 'destination.json', 'receipt.json', 'chatgpt.json']) {
        await unlink(join(tasks, jobId, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await rmdir(join(tasks, jobId));
    }
    for (const file of files) await unlink(file).catch(e => { if (e.code !== 'ENOENT') throw e; });
    await rmdir(temporary);
  }
});

test('exercise capture sets reject gaps, conflicting records, unrelated files and original batch limits', () => {
  const record = syntheticActivityBatch().records[0], original = capture([record]);
  const first = { start: auditWindow.start, end: '2026-01-01T08:00:00Z' };
  const afterGap = { start: '2026-01-01T09:00:00Z', end: auditWindow.end };
  assert.equal(previewBridgeImport('activity', { captures: [capture([record], first),
    capture([], { start: first.end, end: auditWindow.end })] }, auditWindow).counts.sourceRecords, 1);
  for (const captures of [
    [original],
    Array(32).fill(original),
    [capture([record], first), capture([], afterGap)],
    [original, capture([{ ...record, modifyTime: record.modifyTime + 1 }])],
    [original, capture([{ ...record, activitySummary: { conflict: 1 } }])],
    [original, syntheticSleepBatch().capture],
    [original, [record]],
    [original, { ...original, apiRequest: { ...original.apiRequest, limit: 21 } }],
    Array.from({ length: 6 }, () => capture(Array.from({ length: 20 }, () => syntheticActivityBatch().records[0]))),
  ]) assert.throws(() => previewBridgeImport('activity', { captures }, auditWindow), /invalid_activity_capture_set/);
  assert.throws(() => previewBridgeImport('activity', { captures: [original, original] },
    { start: first.end, end: auditWindow.end }), /invalid_activity_capture_set/);
});

test('read-only preview uses original validation for every input format and exports counts and limits without body or task selectors', async () => {
  const records = syntheticActivityBatch().records;
  records[0].activitySummary = { syntheticText: marker };
  const before = await ids(), priorFetch = globalThis.fetch; let calls = 0;
  try {
    globalThis.fetch = async () => { calls++; throw Error('preview must be offline'); };
    for (const [kind, input, format] of [
      ['sleep', syntheticSleepBatch().capture, 'sleep_capture'],
      ['activity', records, 'activity_record_array'],
      ['activity', capture(records), 'activity_first_response_capture'],
    ] as const) {
      const preview = previewBridgeImport(kind, input, auditWindow);
      assert.deepEqual(previewBridgeImport(kind, input, auditWindow), preview, 'repeated preview is deterministic');
      assert.equal(preview.status, 'validated_locally_no_task_created'); assert.equal(preview.collection.inputFormat, format);
      assert(preview.requestBytes > 0); assert.equal(preview.sourceCompleteness, 'unknown');
      for (const field of ['jobId', 'batchId', 'body', 'requestHash', 'payload']) assert(!(field in preview));
      const serialized = JSON.stringify(preview);
      for (const text of [marker, records[0].id, 'synthetic-collector', 'synthetic-repeated-sleep-id', 'rawResponse']) assert(!serialized.includes(text));
    }
    for (const [kind, input, window] of [
      ['sleep', records, auditWindow], ['activity', syntheticSleepBatch().capture, auditWindow],
      ['activity', records, { start: '2026-01-02T00:00:00Z', end: auditWindow.end }],
      ['activity', records, { start: auditWindow.start, end: '2026-03-01T00:00:00Z' }],
      ['activity', capture(Array.from({ length: 21 }, () => syntheticActivityBatch().records[0])), auditWindow],
      ['activity', [{ ...records[0], activitySummary: { syntheticLarge: 'x'.repeat(2 * 1024 * 1024) } }], auditWindow],
    ] as const) assert.throws(() => previewBridgeImport(kind, input, window), /invalid_bridge_import_job/);
    assert.equal(calls, 0); assert.deepEqual(await ids(), before);
  } finally { globalThis.fetch = priorFetch; }
});

test('actual preview CLI leaves input and task catalog untouched on repeat, validation failure and malformed commands', async () => {
  const temporary = await mkdtemp(fileURLToPath(new URL('../../.tools/bridge-preview-', import.meta.url)));
  const file = join(temporary, 'synthetic.json'), before = await ids();
  try {
    for (const [kind, input] of [['sleep', syntheticSleepBatch().capture], ['activity', capture(syntheticActivityBatch().records)]] as const) {
      const source = JSON.stringify(input); await writeFile(file, source);
      const result = command('preview', kind, file); assert.equal(result.status, 0, result.stderr);
      const preview = JSON.parse(result.stdout); assert.equal(preview.status, 'validated_locally_no_task_created');
      assert.equal(command('preview', kind, file).stdout, result.stdout);
      assert.equal(await readFile(file, 'utf8'), source); assert.deepEqual(await ids(), before);
      if (process.platform === 'win32') {
        const menu = spawnSync('pwsh', ['-NoProfile', '-File', fileURLToPath(new URL('../../tools/Bridge.ps1', import.meta.url)), '-Action', 'preview'],
          { encoding: 'utf8', input: [kind, file, auditWindow.start, auditWindow.end, ''].join('\n'), timeout: 15000 });
        assert.equal(menu.status, 0, menu.stderr); assert.match(menu.stdout, /validated_locally_no_task_created/);
        assert(!menu.stdout.includes('"jobId"')); assert.equal(await readFile(file, 'utf8'), source); assert.deepEqual(await ids(), before);
      }
      const mismatch = command('preview', kind === 'sleep' ? 'activity' : 'sleep', file);
      assert.equal(mismatch.status, 1); assert.equal(mismatch.stdout, '');
      assert.equal(JSON.parse(mismatch.stderr).error, 'invalid_bridge_import_job');
    }
    await writeFile(file, '{"' + marker);
    for (const [filePath, extra, error] of [[file, [], 'local_file_invalid'], [file, [marker], 'invalid_bridge_command'],
      [join(temporary, marker), [], 'local_file_invalid']] as const) {
      const result = command('preview', 'activity', filePath, [...extra]);
      assert.equal(result.status, 1); assert.equal(result.stdout, ''); assert.equal(JSON.parse(result.stderr).error, error);
      assert(!result.stderr.includes(marker)); assert(!result.stderr.includes(temporary));
    }
    assert.deepEqual(await ids(), before);
  } finally { await unlink(file); await rmdir(temporary); }
});

test('prepare rereads a changed file after preview and completes the original task/REST/phone/MCP path with the newly validated contents', async () => {
  const c = await createSyntheticFixture();
  const temporary = await mkdtemp(fileURLToPath(new URL('../../.tools/bridge-preview-', import.meta.url))), file = join(temporary, 'synthetic.json');
  let id: string | undefined;
  try {
    const original = syntheticActivityBatch().records; await writeFile(file, JSON.stringify(original));
    const preview = command('preview', 'activity', file); assert.equal(preview.status, 0);
    assert.equal(JSON.parse(preview.stdout).counts.sourceRecords, 1);
    const before = await ids();
    await writeFile(file, 'null'); assert.equal(command('prepare', 'activity', file).status, 1); assert.deepEqual(await ids(), before);
    const changed = [syntheticActivityBatch().records[0], syntheticActivityBatch().records[0]], source = JSON.stringify(changed);
    await writeFile(file, source);
    const prepared = command('prepare', 'activity', file); assert.equal(prepared.status, 0, prepared.stderr);
    id = JSON.parse(prepared.stdout).jobId; assert(id);
    assert.equal((await inspectImportTask(id)).preview.counts.sourceRecords, 2);
    const job = JSON.parse(await readFile(join(tasks, id, 'job.json'), 'utf8'));
    assert.deepEqual(JSON.parse(job.payload.body).records.map((r: any) => r.id), changed.map(r => r.id));
    assert(!job.payload.body.includes(original[0].id));
    await uploadImportTask(id, { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['ExerciseSessionRecord'] }, async preview => {
        assert.equal(preview.counts.sourceRecords, 2); return true;
      }, async (url, init) => c.api(new Request(String(url), init)));
    const guide = await selectImportTaskChatGptGuide(id), result = await c.call('health_records', guide.queries.health_records);
    assert.notEqual(result.isError, true); assert.equal((await inspectImportTask(id)).state, 'committed_receipt_saved');
    assert.equal(await readFile(file, 'utf8'), source);
  } finally {
    await c.pg.close();
    if (id) {
      for (const name of ['job.json', 'destination.json', 'receipt.json', 'chatgpt.json']) await unlink(join(tasks, id, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      await rmdir(join(tasks, id));
    }
    await unlink(file); await rmdir(temporary);
  }
});
