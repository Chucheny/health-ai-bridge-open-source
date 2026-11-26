// Explicit local commands only. Running prepare never reads credentials or contacts any service.
import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { execFileSync } from 'node:child_process';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bindSleepUploadDestination, boundedSleepJson as boundedJson, saveSleepUploadReceipt } from './trainingcamp-sleep-files.mts';
import { MAX_TRAININGCAMP_CAPTURE_BYTES } from './trainingcamp-capture.mts';
import { sleepSnapshotChatGptGuide } from './bridge-chatgpt-guide.mts';
import { listSleepSnapshots, parseSleepClientConfig, parseSleepUploadJob, prepareSleepUpload,
  uploadSleepJob } from './trainingcamp-sleep-client.mts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
async function safeDirectory(path: string) {
  await mkdir(path, { recursive: false, mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local_file_invalid');
}
async function privateDirectory(name: string) {
  const base = join(root, 'private'); await safeDirectory(base);
  const directory = join(base, name); await safeDirectory(directory);
  return directory;
}
async function protectNewDirectory(path: string) {
  if (process.platform === 'win32') {
    const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
    if (!identity) throw new Error('local_file_invalid');
    execFileSync('icacls.exe', [path, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`],
      { stdio: 'ignore', windowsHide: true });
  }
}
async function jobDirectory(id: string) {
  if (!z.uuid().safeParse(id).success) throw new Error('local_file_invalid');
  const directory = join(root, 'private', 'trainingcamp-imports', id);
  // Do not follow a private/job directory that has been replaced by a symlink.
  for (const path of [join(root, 'private'), join(root, 'private', 'trainingcamp-imports'), directory]) {
    const info = await lstat(path); if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local_file_invalid');
  }
  return directory;
}
async function ask(question: string) {
  if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
  const rl = createInterface({ input: stdin, output: stdout });
  try { return (await rl.question(question)).trim(); } finally { rl.close(); }
}
const usage = '用法：prepare <采集文件> <授权开始ISO时间> <授权结束ISO时间> | upload <任务ID> <Bridge配置文件> | select <Bridge配置文件> <开始ISO时间> <结束ISO时间>。结束时间不包含在范围内。';
try {
  const [command, ...args] = process.argv.slice(2);
  if (command === 'prepare' && args.length === 3) {
    const job = prepareSleepUpload(await boundedJson(args[0], MAX_TRAININGCAMP_CAPTURE_BYTES), { start: args[1], end: args[2] });
    const parent = await privateDirectory('trainingcamp-imports'), id = randomUUID(), directory = join(parent, id);
    await mkdir(directory, { mode: 0o700 }); await protectNewDirectory(directory);
    await writeFile(join(directory, 'job.json'), JSON.stringify(job, null, 2), { flag: 'wx', mode: 0o600 });
    stdout.write(JSON.stringify({ status: 'prepared_locally_not_uploaded', jobId: id, ...job.preview }) + '\n');
  } else if (command === 'upload' && args.length === 2) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
    const directory = await jobDirectory(args[0]);
    const job = parseSleepUploadJob(await boundedJson(join(directory, 'job.json'), 2 * MAX_TRAININGCAMP_CAPTURE_BYTES));
    const config = parseSleepClientConfig(await boundedJson(args[1], 65536));
    const receipt = await uploadSleepJob(job, config, async preview => {
      stdout.write('将上传到所选 Bridge 配置（不是华为网页登录配置）：\n' + JSON.stringify(preview, null, 2) + '\n');
      if (await ask(`请核对账号、目标及日期；仅输入“上传 ${preview.destination}”才发送，否则取消：`) !== `上传 ${preview.destination}`) return false;
      await bindSleepUploadDestination(directory, config);
      return true;
    });
    await saveSleepUploadReceipt(directory, receipt);
    stdout.write(JSON.stringify({ status: 'uploaded_receipt_saved', snapshotId: receipt.snapshotId,
      snapshotCreated: receipt.snapshotCreated, next: 'select' }) + '\n');
  } else if (command === 'select' && args.length === 3) {
    if (!stdin.isTTY || !stdout.isTTY) throw new Error('interactive_terminal_required');
    const config = parseSleepClientConfig(await boundedJson(args[0], 65536));
    const window = { start: args[1], end: args[2] }; let cursor: string | undefined;
    stdout.write(`仅列出 ${config.baseUrl} 中完整落在所选日期内的已导入快照；顺序不代表新旧。\n`);
    for (;;) {
      const page = await listSleepSnapshots(config, window, cursor);
      if (!page.snapshots.length) { stdout.write('本页没有匹配快照，不能据此推断没有睡眠。\n'); break; }
      for (const [index, item] of page.snapshots.entries()) stdout.write(JSON.stringify({ number: index + 1, ...item }) + '\n');
      const choice = await ask(`输入本页编号选择${page.nextCursor ? '，n读取下一页' : ''}；其他输入取消：`);
      if (choice === 'n' && page.nextCursor) { cursor = page.nextCursor; continue; }
      if (!/^[1-9]\d?$/.test(choice) || !page.snapshots[Number(choice) - 1]) break;
      const selected = page.snapshots[Number(choice) - 1];
      const { queries, prompt } = sleepSnapshotChatGptGuide(selected);
      const parent = await privateDirectory('trainingcamp-choices'), id = randomUUID(), directory = join(parent, id);
      await mkdir(directory, { mode: 0o700 }); await protectNewDirectory(directory);
      await writeFile(join(directory, 'selection.json'), JSON.stringify({ schemaVersion: 1, destination: config.baseUrl,
        snapshot: selected, queries }, null, 2), { flag: 'wx', mode: 0o600 });
      stdout.write('已保存所选快照的查询参数。以下说明可复制到手机 ChatGPT：\n\n' + prompt + '\n\n');
      stdout.write(JSON.stringify({ status: 'selection_saved', selectionId: id }) + '\n');
      break;
    }
  } else { stdout.write(usage + '\n'); process.exitCode = 1; }
} catch (error) {
  const code = error instanceof Error ? error.message : '';
  const safe = /^(invalid_sleep_(upload_job|client_config|catalog_query|snapshot_choice)|upload_cancelled|upload_destination_changed|bridge_outcome_unknown|bridge_rejected_(400|401|403|404|409|413|415|429)|interactive_terminal_required|uploaded_receipt_not_saved|local_file_invalid)$/.test(code)
    ? code : 'local_command_failed';
  const recovery: Record<string, string> = {
    upload_cancelled: '已取消，本次未发送上传请求。保留原任务，需要上传时重新运行并核对。',
    upload_destination_changed: '本次未发送上传请求。目标绑定不一致或无法保存/读取；保留原任务及绑定文件，核对原目标和本地文件，不要删除绑定后改投其他账号。',
    bridge_outcome_unknown: process.argv[2] === 'upload'
      ? '服务端可能已经保存。保留原任务与批次，不要重新prepare；核对后手动重试同一任务和目标。'
      : '本次未能确认快照目录结果；核对配置与日期后手动重试，不能据此推断没有睡眠。',
    uploaded_receipt_not_saved: '服务端已确认保存，但本地回执未能保存或与已有文件不一致。保留原任务及已有文件，核对文件权限和内容后手动重试同一任务，不要重新prepare。',
  };
  console.error(JSON.stringify({ error: safe, automaticRetry: false, ...(recovery[safe] ? { recovery: recovery[safe] } : {}) })); process.exitCode = 1;
}
