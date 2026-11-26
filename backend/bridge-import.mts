// Application workflow shared by local entry points. No browser, filesystem or network I/O on import.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { contentHash } from './protocol.mts';
import { bridgeJson, parseBridgeClientConfig } from './bridge-client.mts';
import { WEB_IMPORT_ROUTES } from './bridge-sources.mts';
import { parseTrainingCampImport } from './trainingcamp-store.mts';
import { MAX_SLEEP_UPLOAD_BYTES, parseSleepUploadJob, parseSleepUploadReceipt, prepareSleepUpload,
  sleepReceiptMcpArgs, uploadSleepJob } from './trainingcamp-sleep-client.mts';
import { combineTrainingCampActivityCaptures, verifyTrainingCampActivityCapture } from './trainingcamp-capture.mts';

const kindSchema = z.enum(['sleep', 'activity']);
export type BridgeImportKind = z.infer<typeof kindSchema>;
const inputFormatSchema = z.enum(['sleep_capture', 'activity_first_response_capture', 'activity_first_response_set',
  'activity_bounded_scroll_capture', 'activity_record_array']);
const envelope = z.strictObject({ schemaVersion: z.literal(1), kind: kindSchema,
  inputFormat: inputFormatSchema.optional(), payload: z.unknown() });
const activityReceiptSchema = z.strictObject({ batchId: z.uuid(), source: z.literal('huawei_trainingcamp'),
  committed: z.literal(true), committedAt: z.iso.datetime({ offset: true }),
  receivedRecords: z.number().int().min(0).max(100), changedRecords: z.number().int().min(0).max(100),
  sourceCompleteness: z.literal('unknown'), deletionDetection: z.literal('not_available') });

function prepareActivity(records: unknown, window: unknown, batchId: string) {
  const parsed = parseTrainingCampImport({ schemaVersion: 1, batchId, source: 'huawei_trainingcamp', requestedWindow: window, records });
  // Persist only the already retained source fields, excluding unrelated device/account metadata.
  const request = { schemaVersion: 1, batchId, source: 'huawei_trainingcamp', requestedWindow: parsed.requestedWindow,
    records: parsed.records.map(r => ({ id: r.sourceRecordId, activityType: r.sourceType,
      startTime: r.startTimeMs, endTime: r.endTimeMs, modifyTime: r.sourceModifiedTimeMs,
      timeZone: r.sourceTimeZone, activeTime: r.rawActiveTime ?? undefined, activitySummary: r.sourceSummary ?? undefined })) };
  const body = JSON.stringify(request, (_key, value) => {
    if (typeof value === 'number' && (!Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER)) {
      throw new Error('invalid_bridge_import_job');
    }
    return value;
  });
  if (Buffer.byteLength(body) > MAX_SLEEP_UPLOAD_BYTES) throw new Error('invalid_bridge_import_job');
  return { schemaVersion: 1 as const, body, requestHash: contentHash(body), preview: {
    batchId, requestedWindow: parsed.requestedWindow, counts: { sourceRecords: parsed.records.length },
    requestBytes: Buffer.byteLength(body), sourceCompleteness: 'unknown' as const,
  } };
}

export type BridgeImportJob = { schemaVersion: 1; inputFormat?: z.infer<typeof inputFormatSchema> } & (
  { kind: 'sleep'; payload: ReturnType<typeof prepareSleepUpload> } |
  { kind: 'activity'; payload: ReturnType<typeof prepareActivity> }
);

export function prepareBridgeImport(kindInput: unknown, input: unknown, authorizedWindow: unknown, batchId = randomUUID()): BridgeImportJob {
  const multiple = kindInput === 'activity' && input !== null && typeof input === 'object' && Object.hasOwn(input, 'captures');
  try {
    const kind = kindSchema.parse(kindInput);
    if (kind === 'sleep') return { schemaVersion: 1, kind, inputFormat: 'sleep_capture', payload: prepareSleepUpload(input, authorizedWindow, batchId) };
    if (Array.isArray(input)) return { schemaVersion: 1, kind, inputFormat: 'activity_record_array', payload: prepareActivity(input, authorizedWindow, batchId) };
    if (multiple) {
      const { records, requestedWindow } = combineTrainingCampActivityCaptures(input, authorizedWindow);
      return { schemaVersion: 1, kind, inputFormat: 'activity_first_response_set', payload: prepareActivity(records, requestedWindow, batchId) };
    }
    const capture = verifyTrainingCampActivityCapture(input, authorizedWindow);
    return { schemaVersion: 1, kind, inputFormat: capture.captureScope === 'bounded_scroll'
      ? 'activity_bounded_scroll_capture' : 'activity_first_response_capture',
      payload: prepareActivity(capture.records, capture.requestedWindow, batchId) };
  } catch { throw new Error(multiple ? 'invalid_activity_capture_set' : 'invalid_bridge_import_job'); }
}
export function parseBridgeImportJob(input: unknown): BridgeImportJob {
  try {
    const saved = envelope.parse(input);
    if (saved.kind === 'sleep') {
      if (saved.inputFormat !== undefined && saved.inputFormat !== 'sleep_capture') throw new Error();
      return { ...saved, kind: 'sleep', payload: parseSleepUploadJob(saved.payload) };
    }
    if (saved.inputFormat === 'sleep_capture') throw new Error();
    const payload = z.strictObject({ schemaVersion: z.literal(1), body: z.string().max(MAX_SLEEP_UPLOAD_BYTES),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/), preview: z.unknown() }).parse(saved.payload);
    if (Buffer.byteLength(payload.body) > MAX_SLEEP_UPLOAD_BYTES || contentHash(payload.body) !== payload.requestHash) throw new Error();
    const body = JSON.parse(payload.body), parsed = parseTrainingCampImport(body);
    const rebuilt = prepareActivity(body.records, parsed.requestedWindow, parsed.batchId);
    if (saved.inputFormat === 'activity_first_response_capture' && rebuilt.preview.counts.sourceRecords > 20) throw new Error();
    return { ...saved, kind: 'activity' as const, payload: { ...rebuilt, body: payload.body, requestHash: payload.requestHash } };
  } catch { throw new Error('invalid_bridge_import_job'); }
}

/** Local input classification only; never proof of live access, source coverage, or an authorization. */
export function bridgeImportCollection(jobInput: unknown) {
  const job = parseBridgeImportJob(jobInput), inputFormat = job.inputFormat ?? 'legacy_unspecified';
  const notices = {
    sleep_capture: '输入为睡眠采集文件，保存单次响应的观察结果；源端完整分页未经验证，不代表全期睡眠已采齐。',
    activity_first_response_capture: '输入为网页运动首批采集文件，最多20条、未翻页；空响应或少于20条也不能证明全期运动已采齐。',
    activity_first_response_set: '输入为多个网页运动首批文件，每份最多20条。已去除跨文件内容一致的重复记录。各窗口可能仍有漏读，包括跨越采集边界的运动。',
    activity_bounded_scroll_capture: '输入为网页运动续读文件，沿网页的时间边界最多请求5页、接收100条。时间重叠或同时间记录可能漏读，覆盖范围仍未知。',
    activity_record_array: '输入为所提供的运动记录数组；无法从数组核实采集方式、源端分页或全期覆盖，不推断为网页首批或全部运动。',
    legacy_unspecified: '旧任务未记录输入格式，采集方式和源端分页未知；不推断为首批、完整采集或最新数据。',
  };
  return { inputFormat, sourceCompleteness: 'unknown' as const, sourcePaginationVerified: false as const,
    liveReadingVerified: false as const,
    notice: notices[inputFormat] + ' 此标记仅说明本地输入格式，不能证明真实取数；后端游标读到末页也不证明源端已完整采集。' };
}

/** Same validation as prepare, with no task, batch selector, request body, filesystem or network output. */
export function previewBridgeImport(kind: unknown, input: unknown, authorizedWindow: unknown) {
  // Validator-only ID keeps request-byte accounting deterministic; never returned, persisted or sent.
  const job = prepareBridgeImport(kind, input, authorizedWindow, '00000000-0000-4000-8000-000000000002');
  const { batchId: _batchId, ...preview } = job.payload.preview;
  return { status: 'validated_locally_no_task_created' as const, kind: job.kind, ...preview,
    collection: bridgeImportCollection(job) };
}

function activityReceipt(job: BridgeImportJob, input: unknown) {
  const receipt = activityReceiptSchema.parse(input);
  if (receipt.batchId !== job.payload.preview.batchId || receipt.receivedRecords !== job.payload.preview.counts.sourceRecords ||
      receipt.changedRecords > receipt.receivedRecords) throw new Error();
  return receipt;
}
export function parseBridgeImportReceipt(jobInput: unknown, input: unknown) {
  try {
    const job = parseBridgeImportJob(jobInput);
    const saved = z.strictObject({ schemaVersion: z.literal(1), kind: kindSchema,
      requestHash: z.string(), receipt: z.unknown() }).parse(input);
    if (saved.kind !== job.kind || saved.requestHash !== job.payload.requestHash) throw new Error();
    return { ...saved, receipt: job.kind === 'sleep'
      ? parseSleepUploadReceipt(parseSleepUploadJob(job.payload), saved.receipt) : activityReceipt(job, saved.receipt) };
  } catch { throw new Error('invalid_bridge_import_receipt'); }
}
export type BridgeImportReceipt = ReturnType<typeof parseBridgeImportReceipt>;
export type BridgeImportPreview = BridgeImportJob['payload']['preview'] & {
  kind: BridgeImportKind; destination: string; configuredOwnerId: string; configuredSourceId: string;
  collection: ReturnType<typeof bridgeImportCollection>;
};

export async function uploadBridgeImport(jobInput: unknown, configInput: unknown,
  confirm: (preview: BridgeImportPreview) => Promise<boolean>, fetcher: typeof fetch = globalThis.fetch): Promise<BridgeImportReceipt> {
  const job = parseBridgeImportJob(jobInput);
  const config = parseBridgeClientConfig(configInput, job.kind === 'sleep' ? 'SleepSessionRecord' : 'ExerciseSessionRecord');
  const preview = { ...job.payload.preview, kind: job.kind, collection: bridgeImportCollection(job), destination: config.baseUrl,
    configuredOwnerId: config.ownerId, configuredSourceId: config.sourceId };
  let receipt: unknown;
  if (job.kind === 'sleep') receipt = await uploadSleepJob(job.payload, config, () => confirm(preview), fetcher);
  else {
    if (!await confirm(preview)) throw new Error('upload_cancelled');
    const response = await bridgeJson(config, WEB_IMPORT_ROUTES.activity, { method: 'POST', body: job.payload.body }, fetcher);
    try { receipt = activityReceipt(job, response); } catch { throw new Error('bridge_outcome_unknown'); }
  }
  return parseBridgeImportReceipt(job, { schemaVersion: 1, kind: job.kind, requestHash: job.payload.requestHash, receipt });
}

/** Explicitly selecting this task's receipt creates parameters only; never calls MCP or infers latest. */
export function bridgeImportQueries(jobInput: unknown, receiptInput: unknown) {
  const job = parseBridgeImportJob(jobInput), saved = parseBridgeImportReceipt(job, receiptInput);
  if (job.kind === 'sleep') return {
    querySemantics: 'explicit_task_receipt_snapshot' as const,
    queries: sleepReceiptMcpArgs(job.payload, saved.receipt),
  };
  const args = { source: 'huawei_trainingcamp', type: 'ExerciseSessionRecord', ...job.payload.preview.requestedWindow };
  return { querySemantics: 'live_activity_window_not_batch_snapshot' as const,
    queries: { health_records: args, health_summary: args } };
}
