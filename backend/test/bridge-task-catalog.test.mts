import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rmdir, symlink, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { catalogImportTaskIds } from '../bridge-task-catalog.mts';

test('local task catalog pages only explicit UUID directories without opening even damaged task contents', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hab-task-catalog-'));
  const ids = Array.from({ length: 25 }, () => randomUUID()).sort();
  const regularFile = randomUUID();
  try {
    for (const id of ids) { await mkdir(join(directory, id)); await writeFile(join(directory, id, 'job.json'), 'not-json synthetic-private-sentinel'); }
    await mkdir(join(directory, 'unrelated-private-sentinel')); await writeFile(join(directory, regularFile), 'synthetic-private-sentinel');
    const first = await catalogImportTaskIds(directory); assert.equal(first.tasks.length, 20); assert.equal(first.nextCursor, ids[19]);
    const next = await catalogImportTaskIds(directory, first.nextCursor!); assert.equal(next.tasks.length, 5); assert.equal(next.nextCursor, null);
    assert.deepEqual([...first.tasks, ...next.tasks].map(t => t.jobId), ids);
    assert(!JSON.stringify(first).includes('private-sentinel')); assert.equal(first.order, 'task_id_not_creation_time_or_source_version');
    assert.equal(await readFile(join(directory, ids[0], 'job.json'), 'utf8'), 'not-json synthetic-private-sentinel');
    await assert.rejects(catalogImportTaskIds(directory, '../config'), /invalid_bridge_task_cursor/);
  } finally {
    for (const id of ids) { await unlink(join(directory, id, 'job.json')); await rmdir(join(directory, id)); }
    await rmdir(join(directory, 'unrelated-private-sentinel')); await unlink(join(directory, regularFile)); await rmdir(directory);
  }
});

test('task catalog rejects linked roots and omits directory links instead of following other private locations', async () => {
  const tools = fileURLToPath(new URL('../../.tools/', import.meta.url)); await mkdir(tools, { recursive: true });
  const directory = await mkdtemp(join(tools, 'hab-task-links-')), real = join(directory, 'real'), link = join(directory, randomUUID());
  let createdLink = false;
  try {
    await mkdir(real); await symlink(real, link, process.platform === 'win32' ? 'junction' : 'dir'); createdLink = true;
    assert.deepEqual((await catalogImportTaskIds(directory)).tasks, []);
    await assert.rejects(catalogImportTaskIds(link), /local_file_invalid/);
    assert.deepEqual((await catalogImportTaskIds(join(directory, 'absent'))).tasks, []);
    await assert.rejects(catalogImportTaskIds(join(directory, 'absent'), 'invalid'), /invalid_bridge_task_cursor/);
  } finally { if (createdLink) await unlink(link); await rmdir(real); await rmdir(directory); }
});
