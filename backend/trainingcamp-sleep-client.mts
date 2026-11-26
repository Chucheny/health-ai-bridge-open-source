// Local import client primitives. No credentials, files, browser or network are read on import.
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { bridgeJson, parseBridgeClientConfig } from './bridge-client.mts';
import type { BridgeClientConfig } from './bridge-client.mts';
import { contentHash, ns } from './protocol.mts';
import { verifyTrainingCampSleepCapture } from './trainingcamp-capture.mts';
import { parseTrainingCampSleepImport } from './trainingcamp-sleep-store.mts';
import { WEB_IMPORT_ROUTES } from './bridge-sources.mts';

export const MAX_SLEEP_UPLOAD_BYTES = 2 * 1024 * 1024;
const dateWindow = z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) });
export type SleepClientConfig = BridgeClientConfig;
type Fetch = typeof globalThis.fetch;

export function parseSleepClientConfig(input: unknown): SleepClientConfig {
  try { return parseBridgeClientConfig(input, 'SleepSessionRecord'); }
  catch { throw new Error('invalid_sleep_client_config'); }
}
export function prepareSleepUpload(capture: unknown, authorizedWindow: unknown, batchId: string = randomUUID()) {
  try {
    const verified = verifyTrainingCampSleepCapture(capture, authorizedWindow);
    const request = { schemaVersion: 1, batchId, source: 'huawei_trainingcamp', authorizedWindow, capture };
    parseTrainingCampSleepImport(request);
    const body = JSON.stringify(request);
    if (Buffer.byteLength(body) > MAX_SLEEP_UPLOAD_BYTES) throw new Error();
    const sourceStages = verified.records.reduce((sum, record) => sum + record.stages.length, 0);
    return { schemaVersion: 1 as const, body, requestHash: contentHash(body),
      preview: { batchId, requestedWindow: verified.requestedWindow, counts: { ...verified.counts, sourceStages },
        requestBytes: Buffer.byteLength(body), sourceCompleteness: 'unknown' as const } };
  } catch { throw new Error('invalid_sleep_upload_job'); }
}
export type SleepUploadJob = ReturnType<typeof prepareSleepUpload>;
export function parseSleepUploadJob(input: unknown): SleepUploadJob {
  try {
    const saved = z.strictObject({ schemaVersion: z.literal(1), body: z.string().max(MAX_SLEEP_UPLOAD_BYTES),
      requestHash: z.string().regex(/^[a-f0-9]{64}$/), preview: z.unknown() }).parse(input);
    if (Buffer.byteLength(saved.body) > MAX_SLEEP_UPLOAD_BYTES || contentHash(saved.body) !== saved.requestHash) throw new Error();
    const parsed = parseTrainingCampSleepImport(JSON.parse(saved.body));
    const rebuilt = prepareSleepUpload(JSON.parse(saved.body).capture, parsed.authorizedWindow, parsed.batchId);
    // Recompute the preview; persisted display metadata is never trusted.
    return { ...rebuilt, body: saved.body, requestHash: saved.requestHash };
  } catch { throw new Error('invalid_sleep_upload_job'); }
}

const receiptSchema = z.strictObject({ batchId: z.uuid(), source: z.literal('huawei_trainingcamp'), committed: z.literal(true),
  committedAt: z.iso.datetime({ offset: true }), snapshotId: z.uuid(), snapshotCreated: z.boolean(),
  receivedRecords: z.number().int().min(0).max(1000), sourceCompleteness: z.literal('unknown'),
  sourceVersion: z.literal('unavailable'), snapshotSemantics: z.literal('immutable_observation_not_latest'),
  deletionDetection: z.literal('not_available') });

export async function uploadSleepJob(input: unknown, configInput: unknown,
  confirm: (preview: SleepUploadJob['preview'] & { destination: string; configuredOwnerId: string; configuredSourceId: string }) => Promise<boolean>,
  fetcher: Fetch = globalThis.fetch) {
  const job = parseSleepUploadJob(input), config = parseSleepClientConfig(configInput);
  const confirmation = { ...job.preview, destination: config.baseUrl,
    configuredOwnerId: config.ownerId, configuredSourceId: config.sourceId };
  if (!await confirm(confirmation)) throw new Error('upload_cancelled');
  const inputReceipt = await bridgeJson(config, WEB_IMPORT_ROUTES.sleep, { method: 'POST', body: job.body }, fetcher);
  return parseSleepUploadReceipt(job, inputReceipt);
}

export function parseSleepUploadReceipt(job: SleepUploadJob, inputReceipt: unknown) {
  try {
    const receipt = receiptSchema.parse(inputReceipt);
    if (receipt.batchId !== job.preview.batchId || receipt.receivedRecords !== job.preview.counts.sourceRecords) throw new Error();
    return receipt;
  } catch { throw new Error('bridge_outcome_unknown'); }
}

const snapshotSchema = z.strictObject({ snapshotId: z.uuid(), sourceId: z.uuid(), requestedWindow: dateWindow,
  captureReportedAt: z.iso.datetime({ offset: true }), importedAt: z.iso.datetime({ offset: true }),
  sessionCount: z.number().int().min(0).max(1000), sourceCompleteness: z.literal('unknown'), sourceVersion: z.literal('unavailable') });
export type SleepSnapshotChoice = z.infer<typeof snapshotSchema>;
export async function listSleepSnapshots(configInput: unknown, windowInput: unknown, cursor?: string,
  fetcher: Fetch = globalThis.fetch) {
  const config = parseSleepClientConfig(configInput);
  let window: z.infer<typeof dateWindow>;
  try {
    window = dateWindow.parse(windowInput);
    if (ns(window.start) >= ns(window.end) || ns(window.end) - ns(window.start) > 31n * 86400n * 1000000000n ||
        (cursor !== undefined && (cursor.length < 1 || cursor.length > 2048))) throw new Error();
  } catch { throw new Error('invalid_sleep_catalog_query'); }
  const url = new URL('/api/health/trainingcamp/sleep/snapshots', config.baseUrl);
  url.searchParams.set('start', window.start); url.searchParams.set('end', window.end);
  if (cursor) url.searchParams.set('cursor', cursor);
  const input = await bridgeJson(config, url.pathname + url.search, { method: 'GET' }, fetcher);
  try {
    // Ignore service explanatory text; never display arbitrary response fields to the terminal.
    const result = z.object({ source: z.literal('huawei_trainingcamp'), snapshots: z.array(snapshotSchema).max(20),
      nextCursor: z.string().min(1).max(2048).nullable() }).parse(input);
    const seen = new Set<string>();
    for (const item of result.snapshots) {
      if (seen.has(item.snapshotId) || ns(item.requestedWindow.start) < ns(window.start) ||
          ns(item.requestedWindow.end) > ns(window.end) || ns(item.requestedWindow.start) >= ns(item.requestedWindow.end)) throw new Error();
      seen.add(item.snapshotId);
    }
    return result;
  } catch { throw new Error('bridge_outcome_unknown'); }
}
export function sleepSnapshotMcpArgs(input: unknown) {
  try {
    const s = snapshotSchema.parse(input);
    if (ns(s.requestedWindow.start) >= ns(s.requestedWindow.end) ||
        ns(s.requestedWindow.end) - ns(s.requestedWindow.start) > 31n * 86400n * 1000000000n) throw new Error();
    return sleepQueryArgs(s.snapshotId, s.requestedWindow);
  } catch { throw new Error('invalid_sleep_snapshot_choice'); }
}

function sleepQueryArgs(snapshot: string, window: z.infer<typeof dateWindow>) {
  const args = { source: 'huawei_trainingcamp', type: 'SleepSessionRecord', snapshot, ...window };
  return { health_records: { ...args, sleepStages: 'paged' }, health_summary: args };
}
export function sleepReceiptMcpArgs(jobInput: unknown, receiptInput: unknown) {
  const job = parseSleepUploadJob(jobInput), receipt = parseSleepUploadReceipt(job, receiptInput);
  return sleepQueryArgs(receipt.snapshotId, job.preview.requestedWindow);
}
