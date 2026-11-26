import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeCommandError } from '../bridge-errors.mts';
import { prepareBridgeImport } from '../bridge-import.mts';
import { inspectImportTask, prepareImportTask, selectImportTaskChatGptGuide, uploadImportTask } from '../bridge-import-tasks.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const directory = (id: string) => fileURLToPath(new URL('../../private/bridge-imports/' + id + '/', import.meta.url));
const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: '00000000-0000-4000-8000-000000000011',
  sourceId: '00000000-0000-4000-8000-000000000012', token: 's'.repeat(43), allowedTypes: ['SleepSessionRecord', 'ExerciseSessionRecord'] };
const input = (kind: 'sleep' | 'activity') => kind === 'sleep' ? syntheticSleepBatch().capture : syntheticActivityBatch().records;
async function cleanup(id: string) {
  for (const name of ['job.json', 'destination.json', 'receipt.json', 'chatgpt.json']) {
    await unlink(join(directory(id), name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  await rmdir(directory(id));
}

test('changed, missing or unreadable job at confirmation cannot send the previously previewed payload or create a destination', async () => {
  const jobs: string[] = [];
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const task = await prepareImportTask(kind, input(kind), auditWindow); jobs.push(task.jobId);
      const path = directory(task.jobId), original = await readFile(join(path, 'job.json'), 'utf8');
      const metadata = JSON.parse(original); delete metadata.inputFormat;
      for (const changed of ['synthetic-damaged-job', JSON.stringify(prepareBridgeImport(kind, input(kind), auditWindow)),
        JSON.stringify(prepareBridgeImport(kind === 'sleep' ? 'activity' : 'sleep', input(kind === 'sleep' ? 'activity' : 'sleep'), auditWindow)),
        JSON.stringify(metadata), null, Symbol('synthetic-directory-instead-of-job')]) {
        let requests = 0, confirmations = 0;
        try {
          await assert.rejects(uploadImportTask(task.jobId, config, async () => {
            confirmations++;
            if (changed === null) await unlink(join(path, 'job.json'));
            else if (typeof changed === 'symbol') { await unlink(join(path, 'job.json')); await mkdir(join(path, 'job.json')); }
            else await writeFile(join(path, 'job.json'), changed);
            return true;
          }, async () => { requests++; throw Error('synthetic send must not occur'); }), error => {
            const report = bridgeCommandError(error);
            assert.equal(requests, 0, 'confirmation must not send a stale task');
            assert.equal(report.error, 'upload_task_changed'); assert.equal(report.automaticRetry, false);
            assert(!JSON.stringify(report).includes('synthetic-damaged-job')); return true;
          });
          assert.equal(confirmations, 1); assert.equal(requests, 0);
          await assert.rejects(readFile(join(path, 'destination.json')), { code: 'ENOENT' });
          await assert.rejects(readFile(join(path, 'receipt.json')), { code: 'ENOENT' });
          if (changed === null) await assert.rejects(readFile(join(path, 'job.json')), { code: 'ENOENT' });
          else if (typeof changed === 'symbol') assert.deepEqual(await readdir(join(path, 'job.json')), []);
          else assert.equal(await readFile(join(path, 'job.json'), 'utf8'), changed);
        } finally {
          if (typeof changed === 'symbol') await rmdir(join(path, 'job.json'));
          await writeFile(join(path, 'job.json'), original);
        }
      }
    }
  } finally { for (const id of jobs) await cleanup(id); }
});

test('display-only edits and JSON formatting do not change the validated request or block a matching upload', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const task = await prepareImportTask(kind, input(kind), auditWindow); jobs.push(task.jobId); const path = directory(task.jobId);
      const original = JSON.parse(await readFile(join(path, 'job.json'), 'utf8')), displayEdit = structuredClone(original);
      displayEdit.payload.preview.counts.sourceRecords = 999; displayEdit.payload.preview.injectedText = 'synthetic-display-text';
      await uploadImportTask(task.jobId, { ...config, ownerId: c.owner, sourceId: c.source, token: c.token }, async () => {
        await writeFile(join(path, 'job.json'), JSON.stringify(displayEdit)); return true;
      }, async (url, init) => {
        assert.equal(init?.body, original.payload.body); return c.api(new Request(String(url), init));
      });
      assert.equal((await inspectImportTask(task.jobId)).state, 'committed_receipt_saved');
      assert.notEqual((await inspectImportTask(task.jobId)).preview.counts.sourceRecords, 999);
    }
  } finally { await c.pg.close(); for (const id of jobs) await cleanup(id); }
});

test('post-request job or destination changes keep confirmed server outcome separate and permit recovery only with restored original task', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  const selected = { ...config, ownerId: c.owner, sourceId: c.source, token: c.token };
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      for (const mutation of ['job', 'binding', 'missing_binding']) {
        const task = await prepareImportTask(kind, input(kind), auditWindow); jobs.push(task.jobId); const path = directory(task.jobId);
        const original = await readFile(join(path, 'job.json'), 'utf8'); let binding = '', requests = 0;
        const changed = mutation === 'job' ? JSON.stringify(prepareBridgeImport(kind, input(kind), auditWindow)) : 'synthetic-changed-target';
        await assert.rejects(uploadImportTask(task.jobId, selected, async () => true, async (url, init) => {
          requests++; const response = await c.api(new Request(String(url), init)); assert.equal(response.status, 200);
          binding = await readFile(join(path, 'destination.json'), 'utf8');
          if (mutation === 'missing_binding') await unlink(join(path, 'destination.json'));
          else await writeFile(join(path, mutation === 'job' ? 'job.json' : 'destination.json'), changed);
          return response;
        }), error => {
          assert.equal(bridgeCommandError(error).error, 'uploaded_receipt_not_saved'); return true;
        });
        assert.equal(requests, 1);
        await assert.rejects(readFile(join(path, 'receipt.json')), { code: 'ENOENT' });
        if (mutation === 'missing_binding') await assert.rejects(readFile(join(path, 'destination.json')), { code: 'ENOENT' });
        else assert.equal(await readFile(join(path, mutation === 'job' ? 'job.json' : 'destination.json'), 'utf8'), changed);
        const committed = await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id');
        await writeFile(join(path, 'job.json'), original); await writeFile(join(path, 'destination.json'), binding);
        await uploadImportTask(task.jobId, selected, async () => true, async (url, init) => c.api(new Request(String(url), init)));
        assert.deepEqual(await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id'), committed);
        const guide = await selectImportTaskChatGptGuide(task.jobId);
        assert.notEqual((await c.call('health_records', guide.queries.health_records)).isError, true);
      }
    }
  } finally { await c.pg.close(); for (const id of jobs) await cleanup(id); }
});
