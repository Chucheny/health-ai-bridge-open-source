// Manual PTY drill only: original CLI + original REST handler + in-memory synthetic database.
// No listening server, real credentials, browser, external fetch, or personal capture files.
import assert from 'node:assert/strict';
import { fork, spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rename, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { stdin, stdout } from 'node:process';
import { createSyntheticFixture } from './trainingcamp-fixture.mts';

if (!stdin.isTTY || !stdout.isTTY) throw new Error('Run this synthetic drill in an interactive terminal.');
const fixture = await createSyntheticFixture();
const temporary = await mkdtemp(join(tmpdir(), 'hab-terminal-synthetic-'));
const cli = new URL('../../trainingcamp-sleep-command.mts', import.meta.url);
const imports = fileURLToPath(new URL('../../../private/trainingcamp-imports/', import.meta.url));
const choices = fileURLToPath(new URL('../../../private/trainingcamp-choices/', import.meta.url));
const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: fixture.owner,
  sourceId: fixture.source, token: fixture.token, allowedTypes: ['SleepSessionRecord'] };
const sourcePath = join(temporary, 'synthetic-capture.json'), configPath = join(temporary, 'synthetic-config.json');
let requests = 0, dropNextReceipt = false, jobDirectory: string | undefined;
const generatedChoices: string[] = [];
const exists = async (path: string) => readFile(path, 'utf8').then(() => true, () => false);
async function rowCounts() {
  return (await fixture.pg.query(`SELECT
    (SELECT count(*)::int FROM health_bridge.sync_batches) AS batches,
    (SELECT count(*)::int FROM health_bridge.trainingcamp_sleep_snapshots) AS snapshots,
    (SELECT count(*)::int FROM health_bridge.trainingcamp_sleep_records) AS records`)).rows;
}
async function invoke(args: string[]) {
  let output = '', errors = '';
  const child = fork(fileURLToPath(cli), args, { stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
    execArgv: ['--import', new URL('./trainingcamp-terminal-proxy.mts', import.meta.url).href] });
  child.on('message', async (message: any) => {
    if (message.kind === 'output') { if (message.stream === 'stdout') output += message.text; else errors += message.text; return; }
    if (message.kind !== 'fetch') return;
    try {
      const url = new URL(message.url); assert.equal(url.origin, config.baseUrl, 'external network is forbidden');
      assert(['POST', 'GET'].includes(message.method)); assert.equal(message.redirect, 'error'); requests++;
      const response = await fixture.api(new Request(url, {
        method: message.method, headers: message.headers, ...(message.body ? { body: message.body } : {}),
      }));
      if (dropNextReceipt) {
        dropNextReceipt = false; assert.equal(response.status, 200); await response.body?.cancel();
        child.send({ kind: 'response', error: 'synthetic receipt lost after commit' });
      } else child.send({ kind: 'response', status: response.status, headers: [...response.headers], body: await response.text() });
    } catch { child.send({ kind: 'response', error: 'synthetic target failed' }); }
  });
  const code = await new Promise<number | null>((resolve, reject) => { child.once('error', reject); child.once('exit', resolve); });
  assert(!output.includes(config.token) && !errors.includes(config.token), 'CLI must not print the token');
  return { output, errors, code };
}
function prompt(step: string, answer: string) {
  stdout.write(`\n[仅合成演练] ${step}\n请输入：${answer}\n`);
}
try {
  await writeFile(sourcePath, JSON.stringify(fixture.sleepBatch.capture), { flag: 'wx', mode: 0o600 });
  await writeFile(configPath, JSON.stringify(config), { flag: 'wx', mode: 0o600 });
  const prepared = spawnSync(process.execPath, [fileURLToPath(cli), 'prepare', sourcePath,
    fixture.sleepBatch.authorizedWindow.start, fixture.sleepBatch.authorizedWindow.end],
  { encoding: 'utf8', timeout: 15000 });
  assert.equal(prepared.status, 0, prepared.stderr);
  const jobId = JSON.parse(prepared.stdout).jobId;
  assert.match(jobId, /^[a-f0-9-]{36}$/); jobDirectory = join(imports, jobId);
  const upload = ['upload', jobId, configPath], confirmation = '上传 ' + config.baseUrl;
  const initial = await rowCounts();

  prompt('取消上传；预期不发请求、不保存目标。', '取消');
  const cancelled = await invoke(upload);
  assert.equal(JSON.parse(cancelled.errors).error, 'upload_cancelled'); assert.equal(requests, 0);
  assert.equal(await exists(join(jobDirectory, 'destination.json')), false);
  assert.deepEqual(await rowCounts(), initial);

  prompt('模拟云端已提交但回执丢失；预期一次请求、目标保留、没有本地回执。', confirmation);
  dropNextReceipt = true;
  const lost = await invoke(upload);
  assert.equal(JSON.parse(lost.errors).error, 'bridge_outcome_unknown'); assert.equal(requests, 1);
  assert.equal(await exists(join(jobDirectory, 'destination.json')), true);
  assert.equal(await exists(join(jobDirectory, 'receipt.json')), false);
  const committed = await rowCounts();
  assert.equal((committed[0] as any).batches, (initial[0] as any).batches + 1);

  prompt('重试原任务；预期保存回执，数据库不重复写入。', confirmation);
  const retried = await invoke(upload);
  assert.equal(retried.code, 0); assert.equal(requests, 2);
  assert.equal(JSON.parse(retried.output.split('\n').find(line => line.startsWith('{"status"'))!).status,
    'uploaded_receipt_saved');
  assert.deepEqual(await rowCounts(), committed);
  const savedReceipt = await readFile(join(jobDirectory, 'receipt.json'), 'utf8');

  // An existing but unreadable receipt path must still report that the server succeeded.
  await rename(join(jobDirectory, 'receipt.json'), join(jobDirectory, 'receipt.backup.json'));
  await mkdir(join(jobDirectory, 'receipt.json'));
  prompt('模拟本地回执路径不可读；预期明确显示 uploaded_receipt_not_saved。', confirmation);
  const unsaved = await invoke(upload);
  assert.equal(JSON.parse(unsaved.errors).error, 'uploaded_receipt_not_saved');
  assert.match(JSON.parse(unsaved.errors).recovery, /服务端已确认保存/);
  assert.equal(requests, 3); assert.deepEqual(await rowCounts(), committed);
  await rmdir(join(jobDirectory, 'receipt.json'));
  await rename(join(jobDirectory, 'receipt.backup.json'), join(jobDirectory, 'receipt.json'));

  prompt('已有回执再次手动重试；预期原回执不变、不重复写入。', confirmation);
  assert.equal((await invoke(upload)).code, 0); assert.equal(requests, 4);
  assert.equal(await readFile(join(jobDirectory, 'receipt.json'), 'utf8'), savedReceipt);
  assert.deepEqual(await rowCounts(), committed);

  await writeFile(configPath, JSON.stringify({ ...config, sourceId: randomUUID() }));
  prompt('同一任务改为另一安装；预期在发请求之前拒绝。', confirmation);
  assert.equal(JSON.parse((await invoke(upload)).errors).error, 'upload_destination_changed');
  assert.equal(requests, 4);
  await writeFile(configPath, JSON.stringify(config));

  prompt('明确选择快照；预期仅保存原 MCP 参数，不调用 MCP。', '1');
  const selected = await invoke(['select', configPath, fixture.scope.start, fixture.scope.end]);
  assert.equal(selected.code, 0); assert.equal(requests, 5);
  const savedChoice = JSON.parse(selected.output.split('\n').find(line => line.startsWith('{"status":"selection_saved"'))!);
  assert.match(savedChoice.selectionId, /^[a-f0-9-]{36}$/); generatedChoices.push(savedChoice.selectionId);
  const selection = JSON.parse(await readFile(join(choices, generatedChoices[0], 'selection.json'), 'utf8'));
  const receipt = JSON.parse(savedReceipt);
  assert.equal(selection.queries.health_records.snapshot, receipt.snapshotId);
  assert.equal(selection.queries.health_records.sleepStages, 'paged');
  assert.equal(selection.queries.health_summary.snapshot, receipt.snapshotId);
  assert.match(selected.output, /以下说明可复制到手机 ChatGPT/);
  assert.match(selected.output, /从 Bridge 目录选定一个不可变睡眠快照/);
  const promptArguments = /health_summary 参数：\n\n([\s\S]*?)\n\nhealth_records 首次请求参数：\n\n([\s\S]*?)\n\n分页：/.exec(selected.output);
  assert(promptArguments);
  assert.deepEqual(JSON.parse(promptArguments[1]), selection.queries.health_summary);
  assert.deepEqual(JSON.parse(promptArguments[2]), selection.queries.health_records);
  assert(!JSON.stringify(selection).includes(config.token)); assert.deepEqual(await rowCounts(), committed);
  assert.equal(await readFile(sourcePath, 'utf8'), JSON.stringify(fixture.sleepBatch.capture));
  stdout.write('\nSYNTHETIC_TERMINAL_DRILL_PASS: cancel, lost receipt, replay, local save failure, destination binding, selection.\n');
} finally {
  await fixture.pg.close();
  // Delete only this run's known files and UUID directories; never recursively remove private/.
  if (jobDirectory) {
    for (const name of ['receipt.json', 'receipt.backup.json', 'destination.json', 'job.json']) {
      const path = join(jobDirectory, name);
      try { await unlink(path); } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'EISDIR' || (error as NodeJS.ErrnoException).code === 'EPERM') await rmdir(path);
        else if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      }
    }
    await rmdir(jobDirectory);
  }
  for (const id of generatedChoices) { await unlink(join(choices, id, 'selection.json')); await rmdir(join(choices, id)); }
  await unlink(sourcePath); await unlink(configPath); await rmdir(temporary);
}
