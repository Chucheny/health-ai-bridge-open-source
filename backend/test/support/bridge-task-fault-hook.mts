// Child-process fault injection for synthetic task publication tests only. Never used by application code.
import fs from 'node:fs';
import { syncBuiltinESMExports } from 'node:module';
import { basename } from 'node:path';

const fault = process.env.HAB_SYNTHETIC_TASK_FAULT;
const isJob = (path: unknown) => typeof path === 'string' && /[\\/]bridge-imports[\\/](?:\.preparing-)?[0-9a-f-]{36}[\\/]job\.json$/i.test(path);
function failure() { return Object.assign(new Error('synthetic-private-task-write-failure'), { code: 'ENOSPC' }); }
const originalWrite = fs.promises.writeFile;
fs.promises.writeFile = (async (path: any, data: any, options: any) => {
  if (fault === 'write' && isJob(path)) { await originalWrite(path, String(data).slice(0, 32), options); throw failure(); }
  return originalWrite(path, data, options);
}) as typeof fs.promises.writeFile;
const originalOpen = fs.promises.open;
fs.promises.open = (async (path: any, ...args: any[]) => {
  const handle = await (originalOpen as any)(path, ...args);
  if (isJob(path)) {
    if (fault === 'write') {
      const write = handle.writeFile.bind(handle);
      handle.writeFile = async (data: any, options: any) => { await write(String(data).slice(0, 32), options); throw failure(); };
    }
    if (fault === 'sync') handle.sync = async () => { throw failure(); };
  }
  return handle;
}) as typeof fs.promises.open;
const originalRename = fs.promises.rename;
fs.promises.rename = (async (source: any, target: any) => {
  if (fault === 'publish' && basename(String(source)).startsWith('.preparing-')) throw failure();
  return originalRename(source, target);
}) as typeof fs.promises.rename;
syncBuiltinESMExports();
