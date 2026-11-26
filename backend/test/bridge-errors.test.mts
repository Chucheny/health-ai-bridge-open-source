import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { bridgeCommandError } from '../bridge-errors.mts';
import { MAX_TRAININGCAMP_CAPTURE_BYTES } from '../trainingcamp-capture.mts';
import { inspectImportTask, prepareImportTask, selectImportTaskQueries, uploadImportTask } from '../bridge-import-tasks.mts';
import { createHandler } from '../api.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch } from './support/trainingcamp-fixture.mts';

const cli = fileURLToPath(new URL('../bridge-command.mts', import.meta.url));
const tasks = fileURLToPath(new URL('../../private/bridge-imports/', import.meta.url));
const marker = 'synthetic-private-text-that-must-never-be-displayed';

test('actual CLI classifies missing, malformed, invalid UTF-8 and oversized input without echoing private text or creating tasks', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hab-bridge-errors-'));
  const before = await readdir(tasks).catch(e => { if (e.code === 'ENOENT') return []; throw e; });
  const files = ['broken.json', 'encoding.json', 'large.json'].map(name => join(temporary, name));
  try {
    await writeFile(files[0], '{"' + marker);
    await writeFile(files[1], Buffer.from([0xff]));
    await writeFile(files[2], Buffer.alloc(MAX_TRAININGCAMP_CAPTURE_BYTES + 1, 32));
    for (const file of [join(temporary, marker + '.json'), ...files]) {
      const result = spawnSync(process.execPath, [cli, 'prepare', 'activity', file, auditWindow.start, auditWindow.end], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      const report = JSON.parse(result.stderr);
      assert.equal(report.error, 'local_file_invalid'); assert.equal(report.automaticRetry, false);
      assert.match(report.message, /本地文件/); assert.match(report.recovery, /UTF-8 JSON/);
      assert(!result.stderr.includes(marker)); assert(!result.stderr.includes(temporary));
    }
    for (const [args, expected] of [
      [['prepare', 'unknown-kind', marker, auditWindow.start, auditWindow.end], 'invalid_bridge_command'],
      [['upload', randomUUID(), marker], 'interactive_terminal_required'],
      [['list', marker], 'invalid_bridge_task_cursor'],
    ] as const) {
      const result = spawnSync(process.execPath, [cli, ...args], { encoding: 'utf8', timeout: 10000 });
      assert.equal(result.status, 1); assert.equal(result.stdout, '');
      assert.equal(JSON.parse(result.stderr).error, expected); assert(!result.stderr.includes(marker));
    }
    assert.deepEqual(await readdir(tasks).catch(e => { if (e.code === 'ENOENT') return []; throw e; }), before);
  } finally { for (const file of files) await unlink(file); await rmdir(temporary); }
});

test('fixed command feedback rejects arbitrary exception text and prototype property names', () => {
  for (const error of [new Error(marker), new Error('constructor'), new Error('__proto__'), new Error('toString'),
    new Error('bridge_rejected_503'), { message: marker }, marker, null]) {
    const report = bridgeCommandError(error);
    assert.equal(report.error, 'local_command_failed'); assert.equal(report.automaticRetry, false);
    assert.match(report.recovery, /服务端可能已保存/); assert(!JSON.stringify(report).includes(marker));
  }
});

test('upload recovery feedback follows real rejection, lost receipt and local persistence failure through same-task retry to original MCP', async () => {
  const c = await createSyntheticFixture(); let id: string | undefined, receiptDirectory = false;
  try {
    id = (await prepareImportTask('activity', syntheticActivityBatch().records, auditWindow)).jobId;
    const path = join(tasks, id), original = await readFile(join(path, 'job.json'), 'utf8');
    const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: c.owner, sourceId: c.source,
      token: c.token, allowedTypes: ['ExerciseSessionRecord'] };
    const disabled = createHandler(c.db);
    for (const [expected, fetcher, options] of [
      ['bridge_rejected_401', (url: any, init: any) => c.api(new Request(String(url), init)), { ...config, token: 's'.repeat(43) }],
      ['bridge_rejected_404', (url: any, init: any) => disabled(new Request(String(url), init)), config],
      ['bridge_rejected_429', async () => Response.json({ error: marker }, { status: 429 }), config],
      ['bridge_outcome_unknown', async (url: any, init: any) => {
        const response = await c.api(new Request(String(url), init)); assert.equal(response.status, 200);
        await response.body?.cancel(); throw new Error(marker);
      }, config],
    ] as const) {
      let requests = 0;
      await assert.rejects(uploadImportTask(id, options, async () => true, async (url, init) => {
        requests++; return fetcher(url, init);
      }), error => {
        const report = bridgeCommandError(error);
        assert.equal(report.error, expected); assert.equal(report.automaticRetry, false);
        assert(report.message.length > 0 && report.recovery.length > 0);
        assert(!JSON.stringify(report).includes(marker)); assert(!JSON.stringify(report).includes(c.token));
        return true;
      });
      assert.equal(requests, 1); assert.equal((await inspectImportTask(id)).state, 'bound_without_local_receipt');
      assert.equal(await readFile(join(path, 'job.json'), 'utf8'), original);
    }
    const committed = await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id');
    await assert.rejects(uploadImportTask(id, config, async () => true, async (url, init) => {
      const response = await c.api(new Request(String(url), init));
      await mkdir(join(path, 'receipt.json')); receiptDirectory = true; // Failure appears after preflight/request, before local persistence.
      return response;
    }), error => {
      const report = bridgeCommandError(error); assert.equal(report.error, 'uploaded_receipt_not_saved');
      assert.match(report.message, /服务端已确认保存/); assert.match(report.recovery, /同一任务和目标/); return true;
    });
    await rmdir(join(path, 'receipt.json')); receiptDirectory = false;
    await uploadImportTask(id, config, async () => true, async (url, init) => c.api(new Request(String(url), init)));
    assert.deepEqual(await c.pg.query('SELECT batch_id,request_hash FROM health_bridge.sync_batches ORDER BY batch_id'), committed);
    assert.equal((await inspectImportTask(id)).state, 'committed_receipt_saved');
    const bundle = await selectImportTaskQueries(id);
    assert.notEqual((await c.call('health_records', bundle.queries.health_records)).isError, true);
    assert.equal(await readFile(join(path, 'job.json'), 'utf8'), original);
  } finally {
    await c.pg.close();
    if (id) {
      if (receiptDirectory) await rmdir(join(tasks, id, 'receipt.json'));
      for (const name of ['job.json', 'receipt.json', 'destination.json', 'queries.json']) {
        await unlink(join(tasks, id, name)).catch(e => { if (e.code !== 'ENOENT') throw e; });
      }
      await rmdir(join(tasks, id));
    }
  }
});
