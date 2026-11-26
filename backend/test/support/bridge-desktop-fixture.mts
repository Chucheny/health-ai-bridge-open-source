// Prepare an isolated workspace for manual WinForms acceptance. All records and receipts are synthetic.
import assert from 'node:assert/strict';
import { copyFile, mkdir, mkdtemp, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { auditWindow, createSyntheticFixture } from './trainingcamp-fixture.mts';

const backend = fileURLToPath(new URL('../../', import.meta.url));
const workspaces = fileURLToPath(new URL('../../../.tools/bridge-desktop/', import.meta.url));
await mkdir(workspaces, { recursive: true });
const workspace = await mkdtemp(join(workspaces, 'synthetic-'));
const isolatedBackend = join(workspace, 'backend');
await mkdir(isolatedBackend);
for (const entry of await readdir(backend, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith('.mts')) {
    await copyFile(join(backend, entry.name), join(isolatedBackend, entry.name));
  }
}

// The task layer resolves storage from its own module path. The copied module uses its own private directory.
const tasks: typeof import('../../bridge-import-tasks.mts') =
  await import(pathToFileURL(join(isolatedBackend, 'bridge-import-tasks.mts')).href);
const fixture = await createSyntheticFixture();
const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: fixture.owner,
  sourceId: fixture.source, token: fixture.token, allowedTypes: ['SleepSessionRecord', 'ExerciseSessionRecord'] };
const window = { start: '2026-01-01T00:00:00+08:00', end: '2026-01-04T00:00:00+08:00' };
const activity = {
  schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'activity', requestedWindow: auditWindow,
  apiRequest: { startTimeMs: String(Date.parse(auditWindow.start)), endTimeMs: String(Date.parse(auditWindow.end) - 1),
    limit: 20, order: 'endTimeDesc' },
  capturedAt: auditWindow.end, sourceCompleteness: 'unknown', captureScope: 'first_response_only',
  rawResponse: JSON.stringify(fixture.activityBatch.records),
};
const inputs = { sleep: fixture.sleepBatch.capture, activity };
const examples = [];
try {
  for (const kind of ['sleep', 'activity'] as const) {
    const inputPath = join(workspace, kind + '.json');
    await writeFile(inputPath, JSON.stringify(inputs[kind]), { flag: 'wx' });
    const prepared = await tasks.prepareImportTask(kind, inputs[kind], window);
    const result = await tasks.uploadImportTask(prepared.jobId, config, async () => true, async (url, init) => {
      assert.equal(new URL(String(url)).origin, config.baseUrl);
      assert.equal(init?.method, 'POST');
      return fixture.api(new Request(String(url), init));
    });
    assert.equal(result.status, 'uploaded_receipt_saved');
    examples.push({ kind, inputPath, confirmedTaskId: prepared.jobId });
  }
} finally {
  await fixture.pg.close();
}

// Keep the upload launcher and configuration absent. Any real upload belongs to a separate acceptance step.
console.log(JSON.stringify({ workspace, startDate: '2026-01-01', endDateInclusive: '2026-01-03', examples }, null, 2));
