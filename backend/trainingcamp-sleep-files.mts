// Local task persistence only. No files or credentials are read on import.
import { open, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { contentHash } from './protocol.mts';
import type { SleepClientConfig, uploadSleepJob } from './trainingcamp-sleep-client.mts';

export async function boundedSleepJson(path: string, max: number, parse: (text: string) => unknown = JSON.parse) {
  const handle = await open(path, 'r');
  try {
    const size = (await handle.stat()).size;
    if (size > max) throw new Error('local_file_invalid');
    // Bound the actual read too, including a file that grows after stat().
    const bytes = Buffer.alloc(max + 1); let offset = 0;
    while (offset <= max) {
      const n = (await handle.read(bytes, offset, max + 1 - offset, null)).bytesRead;
      if (!n) break;
      offset += n;
    }
    if (offset > max) throw new Error('local_file_invalid');
    return parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, offset)));
  } finally { await handle.close(); }
}

export async function persistOnce(path: string, value: unknown, failure: string) {
  try {
    await writeFile(path, JSON.stringify(value, null, 2), { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'EEXIST') {
      try {
        if (contentHash(await boundedSleepJson(path, 65536)) === contentHash(value)) return;
      } catch { /* Unreadable, damaged and oversized existing files retain the operation's outcome. */ }
    }
    throw new Error(failure);
  }
}

export function bindSleepUploadDestination(directory: string, config: SleepClientConfig) {
  return persistOnce(join(directory, 'destination.json'), {
    baseUrl: config.baseUrl, ownerId: config.ownerId, sourceId: config.sourceId,
  }, 'upload_destination_changed');
}

export function saveSleepUploadReceipt(directory: string, receipt: Awaited<ReturnType<typeof uploadSleepJob>>) {
  return persistOnce(join(directory, 'receipt.json'), receipt, 'uploaded_receipt_not_saved');
}
