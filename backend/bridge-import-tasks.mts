// Durable application tasks. All files belong to an explicitly selected UUID, never scan private configuration.
import { execFileSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { lstat, mkdir, open, rename } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { boundedSleepJson as boundedJson, bindSleepUploadDestination as bindDestination, persistOnce } from './trainingcamp-sleep-files.mts';
import { parseBridgeClientConfig } from './bridge-client.mts';
import type { BridgeClientConfig } from './bridge-client.mts';
import { bridgeImportCollection, bridgeImportQueries, parseBridgeImportJob, parseBridgeImportReceipt, prepareBridgeImport, uploadBridgeImport } from './bridge-import.mts';
import type { BridgeImportJob, BridgeImportPreview, BridgeImportReceipt } from './bridge-import.mts';
import { catalogImportTaskIds } from './bridge-task-catalog.mts';
import { bridgeChatGptGuide } from './bridge-chatgpt-guide.mts';

const root = dirname(dirname(fileURLToPath(import.meta.url)));
export type BridgeImportTaskState = 'prepared' | 'bound_without_local_receipt' | 'committed_receipt_saved'
  | 'local_receipt_invalid' | 'local_state_inconsistent';
const destinationSchema = z.strictObject({ baseUrl: z.url().refine(value => {
  const u = new URL(value); return u.protocol === 'https:' && value === u.origin;
}), ownerId: z.uuid(), sourceId: z.uuid() });

async function directory(path: string, create = false) {
  if (create) await mkdir(path, { mode: 0o700 }).catch(error => { if (error.code !== 'EEXIST') throw error; });
  const info = await lstat(path);
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local_file_invalid');
}
async function taskDirectory(id: string) {
  if (!z.uuid().safeParse(id).success) throw new Error('local_file_invalid');
  const privateRoot = join(root, 'private'), parent = join(privateRoot, 'bridge-imports'), path = join(parent, id);
  await directory(privateRoot); await directory(parent);
  await directory(path); return path;
}

async function saveNewTask(job: BridgeImportJob) {
  const jobId = randomUUID(), privateRoot = join(root, 'private'), parent = join(privateRoot, 'bridge-imports');
  const staging = join(parent, '.preparing-' + jobId), published = join(parent, jobId);
  try {
    await directory(privateRoot, true); await directory(parent, true);
    // Non-UUID staging names are never listed or accepted by load/upload/query selection.
    await mkdir(staging, { mode: 0o700 });
    if (process.platform === 'win32') {
      const identity = [process.env.USERDOMAIN, process.env.USERNAME].filter(Boolean).join('\\');
      if (!identity) throw new Error('local_file_invalid');
      execFileSync('icacls.exe', [staging, '/inheritance:r', '/grant:r', `${identity}:(OI)(CI)F`], { stdio: 'ignore', windowsHide: true });
    }
    await directory(staging);
    const handle = await open(join(staging, 'job.json'), 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(job, null, 2)); await handle.sync(); }
    finally { await handle.close(); }
    await directory(privateRoot); await directory(parent); await directory(staging);
    // Refuse a known collision; never intentionally replace an existing task directory.
    try { await lstat(published); throw new Error('task_already_exists'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    await rename(staging, published);
    return jobId;
  } catch {
    // Preserve any incomplete evidence; no recursive cleanup, repair, upload, or automatic retry.
    throw new Error('import_task_not_saved');
  }
}
async function optionalJson(path: string) {
  let info;
  try { info = await lstat(path); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('local_file_invalid');
  return boundedJson(path, 65536);
}
async function load(id: string) {
  const path = await taskDirectory(id);
  const file = join(path, 'job.json'), info = await lstat(file);
  if (!info.isFile() || info.isSymbolicLink()) throw new Error('local_file_invalid');
  const job = parseBridgeImportJob(await boundedJson(file, 8 * 1024 * 1024));
  return { path, job };
}

export async function listImportTasks(after?: string) {
  const privateRoot = join(root, 'private');
  try { await directory(privateRoot); } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    // The catalog helper validates the cursor even when no task directory exists.
  }
  return catalogImportTaskIds(join(privateRoot, 'bridge-imports'), after);
}

export async function prepareImportTask(kind: unknown, input: unknown, window: unknown) {
  const job = prepareBridgeImport(kind, input, window), jobId = await saveNewTask(job);
  return { status: 'prepared_locally_not_uploaded', jobId, kind: job.kind, ...job.payload.preview, collection: bridgeImportCollection(job) };
}

export async function inspectImportTask(jobId: string) {
  const { path, job } = await load(jobId);
  let state: BridgeImportTaskState = 'prepared';
  let destination: z.infer<typeof destinationSchema> | undefined;
  let committedReceipt: BridgeImportReceipt['receipt'] | undefined;
  try {
    const binding = await optionalJson(join(path, 'destination.json'));
    if (binding !== undefined) { destination = destinationSchema.parse(binding); state = 'bound_without_local_receipt'; }
    const receipt = await optionalJson(join(path, 'receipt.json'));
    if (receipt !== undefined) {
      try {
        const verified = parseBridgeImportReceipt(job, receipt);
        if (destination) {
          state = 'committed_receipt_saved';
          committedReceipt = verified.receipt;
        } else state = 'local_state_inconsistent';
      }
      catch { state = 'local_receipt_invalid'; }
    }
  } catch { state = 'local_state_inconsistent'; }
  const receiptSummary = committedReceipt && {
    committedAt: committedReceipt.committedAt,
    receivedRecords: committedReceipt.receivedRecords,
    ...('snapshotId' in committedReceipt
      ? { snapshotId: committedReceipt.snapshotId, snapshotCreated: committedReceipt.snapshotCreated }
      : { changedRecords: committedReceipt.changedRecords }),
  };
  return { jobId, kind: job.kind, state, preview: job.payload.preview, collection: bridgeImportCollection(job),
    ...(destination ? { destination } : {}), ...(receiptSummary ? { receiptSummary } : {}),
    recovery: state === 'bound_without_local_receipt' ? '服务端结果未知；保留同一任务和批次，核对后明确确认重试。'
      : state === 'local_receipt_invalid' || state === 'local_state_inconsistent' ? '保留任务及已有文件，先核对本地文件；不自动上传或覆盖。' : null };
}

async function checkUploadState(jobId: string, path: string, job: BridgeImportJob, config: BridgeClientConfig) {
  try {
    const current = (await load(jobId)).job;
    if (current.kind !== job.kind || current.inputFormat !== job.inputFormat ||
        current.payload.requestHash !== job.payload.requestHash) throw new Error();
  } catch { throw new Error('upload_task_changed'); }
  let destination: z.infer<typeof destinationSchema> | undefined;
  try {
    const saved = await optionalJson(join(path, 'destination.json'));
    if (saved !== undefined) {
      destination = destinationSchema.parse(saved);
      if (destination.baseUrl !== config.baseUrl || destination.ownerId !== config.ownerId || destination.sourceId !== config.sourceId) throw new Error();
    }
  } catch { throw new Error('upload_destination_changed'); }
  try {
    const saved = await optionalJson(join(path, 'receipt.json'));
    if (saved !== undefined) {
      if (!destination) throw new Error();
      parseBridgeImportReceipt(job, saved);
    }
  } catch { throw new Error('invalid_bridge_import_receipt'); }
  return destination;
}

export async function uploadImportTask(jobId: string, configInput: unknown,
  confirm: (preview: BridgeImportPreview) => Promise<boolean>, fetcher: typeof fetch = globalThis.fetch) {
  const { path, job } = await load(jobId);
  const config = parseBridgeClientConfig(configInput, job.kind === 'sleep' ? 'SleepSessionRecord' : 'ExerciseSessionRecord');
  await checkUploadState(jobId, path, job, config);
  const receipt = await uploadBridgeImport(job, config, async preview => {
    if (!await confirm(preview)) return false;
    // Confirmation can take time; do not authorize a send using an earlier filesystem observation.
    await checkUploadState(jobId, path, job, config);
    await bindDestination(path, config); return true;
  }, fetcher);
  try {
    // The server has confirmed this exact in-memory request. Never attach its receipt to altered local state.
    if (!await checkUploadState(jobId, path, job, config)) throw new Error();
  } catch { throw new Error('uploaded_receipt_not_saved'); }
  await persistOnce(join(path, 'receipt.json'), receipt, 'uploaded_receipt_not_saved');
  return { status: 'uploaded_receipt_saved', kind: job.kind, jobId, receipt: receipt.receipt };
}

async function confirmedTask(jobId: string) {
  const { path, job } = await load(jobId);
  try { destinationSchema.parse(await optionalJson(join(path, 'destination.json'))); }
  catch { throw new Error('invalid_bridge_import_receipt'); }
  const receipt = await optionalJson(join(path, 'receipt.json'));
  return { path, job, receipt };
}

export async function selectImportTaskQueries(jobId: string) {
  const { path, job, receipt } = await confirmedTask(jobId);
  const bundle = bridgeImportQueries(job, receipt);
  await persistOnce(join(path, 'queries.json'), bundle, 'query_bundle_not_saved');
  return { status: 'query_arguments_saved_not_called', jobId, ...bundle };
}

/** Only an explicitly chosen, locally confirmed task can export a guide; never contacts ChatGPT/MCP. */
export async function selectImportTaskChatGptGuide(jobId: string) {
  const { path, job, receipt } = await confirmedTask(jobId);
  const guide = bridgeChatGptGuide(job, receipt);
  await persistOnce(join(path, 'chatgpt.json'), guide, 'chatgpt_guide_not_saved');
  return { status: 'chatgpt_guide_saved_not_sent', jobId, ...guide };
}
