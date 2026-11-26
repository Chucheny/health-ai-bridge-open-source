// Offline ID catalog only: never open job.json, receipt.json, configuration or capture contents.
import { lstat, opendir } from 'node:fs/promises';
import { z } from 'zod';

export async function catalogImportTaskIds(parent: string, after?: string) {
  if (after !== undefined && !z.uuid().safeParse(after).success) throw new Error('invalid_bridge_task_cursor');
  const empty = { tasks: [] as { jobId: string }[], nextCursor: null as string | null,
    order: 'task_id_not_creation_time_or_source_version' as const };
  let info;
  try { info = await lstat(parent); } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return empty;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('local_file_invalid');
  const ids: string[] = [];
  for await (const entry of await opendir(parent)) {
    if (!entry.isDirectory() || entry.isSymbolicLink() || !z.uuid().safeParse(entry.name).success ||
        (after !== undefined && entry.name <= after)) continue;
    ids.push(entry.name); ids.sort();
    if (ids.length > 21) ids.pop(); // Keep a bounded page + one lookahead, irrespective of directory size.
  }
  const page = ids.slice(0, 20);
  return { ...empty, tasks: page.map(jobId => ({ jobId })), nextCursor: ids.length > 20 ? page.at(-1)! : null };
}
