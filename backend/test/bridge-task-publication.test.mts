import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { lstat, mkdtemp, readFile, readdir, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { inspectImportTask, listImportTasks, prepareImportTask, selectImportTaskQueries, uploadImportTask } from '../bridge-import-tasks.mts';
import { parseBridgeImportJob } from '../bridge-import.mts';
import { auditWindow, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

const parent = fileURLToPath(new URL('../../private/bridge-imports/', import.meta.url));
const cli = fileURLToPath(new URL('../bridge-command.mts', import.meta.url));
const hook = new URL('./support/bridge-task-fault-hook.mts', import.meta.url).href;

async function existingTaskEntries(): Promise<string[]> {
  return readdir(parent).catch((error): string[] => {
    if (error.code === 'ENOENT') return [];
    throw error;
  });
}

test('new tasks are published only after a complete validated file is saved, with legacy catalog and inspect semantics', async () => {
  const before = await existingTaskEntries(), jobs: string[] = [];
  try {
    for (const kind of ['sleep', 'activity'] as const) {
      const task = await prepareImportTask(kind, kind === 'sleep' ? syntheticSleepBatch().capture : syntheticActivityBatch().records, auditWindow);
      jobs.push(task.jobId);
      const report = await inspectImportTask(task.jobId); assert.equal(report.state, 'prepared');
      const saved = parseBridgeImportJob(JSON.parse(await readFile(join(parent, task.jobId, 'job.json'), 'utf8')));
      assert.equal(saved.payload.preview.batchId, task.batchId); assert.equal(saved.payload.preview.requestBytes, task.requestBytes);
      assert.equal(saved.inputFormat, task.collection.inputFormat);
      assert((await listImportTasks()).tasks.some(t => t.jobId === task.jobId));
    }
    assert.deepEqual((await readdir(parent)).filter(name => !before.includes(name)).sort(), jobs.sort());
  } finally { for (const id of jobs) { await unlink(join(parent, id, 'job.json')); await rmdir(join(parent, id)); } }
});

test('partial write, sync and publication failures preserve evidence outside task catalog and cannot upload or select queries', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hab-bridge-publication-'));
  const file = join(temporary, 'synthetic-input.json');
  const source = JSON.stringify(syntheticActivityBatch().records); await writeFile(file, source);
  try {
    for (const fault of ['write', 'sync', 'publish']) {
      const before = await existingTaskEntries(); let leftovers: string[] = [];
      try {
        const result = spawnSync(process.execPath, ['--import', hook, cli, 'prepare', 'activity', file, auditWindow.start, auditWindow.end],
          { encoding: 'utf8', timeout: 15000, env: { ...process.env, HAB_SYNTHETIC_TASK_FAULT: fault } });
        leftovers = (await readdir(parent)).filter(name => !before.includes(name));
        assert.equal(result.status, 1); assert.equal(result.stdout, '');
        assert.equal(leftovers.length, 1);
        const retainedId = leftovers[0].replace(/^\.preparing-/, '');
        assert(!(await listImportTasks()).tasks.some(t => t.jobId === retainedId), 'task catalog must not expose an incomplete task');
        assert.equal(JSON.parse(result.stderr).error, 'import_task_not_saved'); assert(!result.stderr.includes('synthetic-private-task-write-failure'));
        assert.equal(leftovers.length, 1); assert.match(leftovers[0], /^\.preparing-[0-9a-f-]{36}$/);
        const id = leftovers[0].slice('.preparing-'.length), path = join(parent, leftovers[0]);
        assert(!(await listImportTasks()).tasks.some(t => t.jobId === id));
        const retained = await readFile(join(path, 'job.json'), 'utf8');
        if (fault === 'write') assert.throws(() => JSON.parse(retained));
        else assert.equal(parseBridgeImportJob(JSON.parse(retained)).kind, 'activity');
        let requests = 0, confirmations = 0;
        await assert.rejects(inspectImportTask(id)); await assert.rejects(selectImportTaskQueries(id));
        await assert.rejects(uploadImportTask(id, {}, async () => { confirmations++; return true; }, async () => { requests++; throw Error('no network'); }));
        assert.equal(requests, 0); assert.equal(confirmations, 0);
        assert.equal(await readFile(join(path, 'job.json'), 'utf8'), retained); assert.equal(await readFile(file, 'utf8'), source);
      } finally {
        // Only this child's single newly created synthetic directory; never recursively remove private/.
        if (leftovers.length === 1 && /^(?:\.preparing-)?[0-9a-f-]{36}$/.test(leftovers[0])) {
          const path = join(parent, leftovers[0]), info = await lstat(path);
          assert(info.isDirectory() && !info.isSymbolicLink());
          const names = await readdir(path); assert(names.every(name => name === 'job.json'));
          if (names.includes('job.json')) await unlink(join(path, 'job.json'));
          await rmdir(path);
        }
      }
    }
  } finally { await unlink(file); await rmdir(temporary); }
});
