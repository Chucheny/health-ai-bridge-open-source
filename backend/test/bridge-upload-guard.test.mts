import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImportTask, prepareImportTask, selectImportTaskChatGptGuide, uploadImportTask } from '../bridge-import-tasks.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const directory = (id: string) => fileURLToPath(new URL('../../private/bridge-imports/' + id + '/', import.meta.url));
async function cleanup(id: string) {
  for (const name of ['job.json', 'destination.json', 'receipt.json', 'chatgpt.json']) {
    await unlink(join(directory(id), name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
  }
  await rmdir(directory(id));
}

test('upload refuses damaged or orphaned receipts and mismatched bindings before confirmation or network while preserving original files', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
    token: c.token, allowedTypes: ['SleepSessionRecord', 'ExerciseSessionRecord'] };
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const task = await prepareImportTask(kind, kind === 'sleep' ? syntheticSleepBatch().capture : syntheticActivityBatch().records, auditWindow);
      jobs.push(task.jobId); const path = directory(task.jobId);
      await uploadImportTask(task.jobId, config, async () => true, async (url, init) => c.api(new Request(String(url), init)));
      const body = await readFile(join(path, 'job.json'), 'utf8'), receipt = await readFile(join(path, 'receipt.json'), 'utf8');
      const binding = await readFile(join(path, 'destination.json'), 'utf8');
      async function blocked(expected: string, selectedConfig = config) {
        let confirmations = 0, requests = 0;
        await assert.rejects(uploadImportTask(task.jobId, selectedConfig, async () => { confirmations++; return true; },
          async () => { requests++; throw Error('synthetic upload must not occur'); }), new RegExp(expected));
        assert.equal(confirmations, 0); assert.equal(requests, 0);
        assert.equal(await readFile(join(path, 'job.json'), 'utf8'), body);
      }
      const altered = JSON.parse(receipt); altered.requestHash = 'f'.repeat(64);
      for (const damaged of ['synthetic-damaged-receipt', 'null', 'x'.repeat(65537), JSON.stringify(altered)]) {
        await writeFile(join(path, 'receipt.json'), damaged);
        try { await blocked('invalid_bridge_import_receipt'); assert.equal(await readFile(join(path, 'receipt.json'), 'utf8'), damaged); }
        finally { await writeFile(join(path, 'receipt.json'), receipt); }
      }
      await unlink(join(path, 'receipt.json')); await mkdir(join(path, 'receipt.json'));
      try { await blocked('invalid_bridge_import_receipt'); }
      finally { await rmdir(join(path, 'receipt.json')); await writeFile(join(path, 'receipt.json'), receipt); }
      await unlink(join(path, 'destination.json'));
      try { await blocked('invalid_bridge_import_receipt'); }
      finally { await writeFile(join(path, 'destination.json'), binding); }
      await writeFile(join(path, 'destination.json'), 'synthetic-damaged-binding');
      try { await blocked('upload_destination_changed'); assert.equal(await readFile(join(path, 'destination.json'), 'utf8'), 'synthetic-damaged-binding'); }
      finally { await writeFile(join(path, 'destination.json'), binding); }
      for (const different of [{ ...config, baseUrl: 'https://another.invalid' }, { ...config, ownerId: randomUUID() }, { ...config, sourceId: randomUUID() }]) {
        await blocked('upload_destination_changed', different);
      }
      assert.equal(await readFile(join(path, 'destination.json'), 'utf8'), binding);
      let rotatedConfirmations = 0;
      await assert.rejects(uploadImportTask(task.jobId, { ...config, token: 't'.repeat(43) }, async () => {
        rotatedConfirmations++; return false;
      }, async () => { throw Error('cancelled upload must not send'); }), /upload_cancelled/);
      assert.equal(rotatedConfirmations, 1, 'a replacement token with the same destination may reach explicit confirmation');
      assert.equal(await readFile(join(path, 'destination.json'), 'utf8'), binding);
      assert.equal((await inspectImportTask(task.jobId)).state, 'committed_receipt_saved');
      const before = await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id');
      await uploadImportTask(task.jobId, config, async () => true, async (url, init) => c.api(new Request(String(url), init)));
      assert.deepEqual(await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id'), before);
      const guide = await selectImportTaskChatGptGuide(task.jobId);
      assert.notEqual((await c.call('health_records', guide.queries.health_records)).isError, true);
    }
  } finally { await c.pg.close(); for (const id of jobs) await cleanup(id); }
});

test('upload rechecks files after confirmation, while a missing receipt alone still permits explicit same-task recovery', async () => {
  const c = await createSyntheticFixture(), jobs: string[] = [];
  const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
    token: c.token, allowedTypes: ['SleepSessionRecord', 'ExerciseSessionRecord'] };
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const task = await prepareImportTask(kind, kind === 'sleep' ? syntheticSleepBatch().capture : syntheticActivityBatch().records, auditWindow);
      jobs.push(task.jobId); const path = directory(task.jobId); let requests = 0, confirmations = 0;
      await assert.rejects(uploadImportTask(task.jobId, config, async () => {
        confirmations++; await writeFile(join(path, 'receipt.json'), 'synthetic-change-during-confirmation'); return true;
      }, async () => { requests++; throw Error('no network'); }), /invalid_bridge_import_receipt/);
      assert.equal(requests, 0); assert.equal(confirmations, 1);
      assert.equal(await readFile(join(path, 'receipt.json'), 'utf8'), 'synthetic-change-during-confirmation');
      await assert.rejects(readFile(join(path, 'destination.json')), { code: 'ENOENT' });
      await unlink(join(path, 'receipt.json'));
      await assert.rejects(uploadImportTask(task.jobId, config, async () => true, async (url, init) => {
        const response = await c.api(new Request(String(url), init)); assert.equal(response.status, 200);
        await response.body?.cancel(); throw Error('synthetic lost receipt');
      }), /bridge_outcome_unknown/);
      assert.equal((await inspectImportTask(task.jobId)).state, 'bound_without_local_receipt');
      const before = await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id');
      await uploadImportTask(task.jobId, config, async () => true, async (url, init) => c.api(new Request(String(url), init)));
      assert.equal((await inspectImportTask(task.jobId)).state, 'committed_receipt_saved');
      assert.deepEqual(await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id'), before);
    }
  } finally { await c.pg.close(); for (const id of jobs) await cleanup(id); }
});
