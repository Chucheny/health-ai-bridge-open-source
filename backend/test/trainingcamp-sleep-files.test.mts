import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, mkdir, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bindSleepUploadDestination, saveSleepUploadReceipt } from '../trainingcamp-sleep-files.mts';
import { parseSleepClientConfig } from '../trainingcamp-sleep-client.mts';

const config = parseSleepClientConfig({ schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: randomUUID(),
  sourceId: randomUUID(), token: 's'.repeat(43), allowedTypes: ['SleepSessionRecord'] });
const receipt = { batchId: randomUUID(), source: 'huawei_trainingcamp', committed: true,
  committedAt: '2026-01-02T00:00:00Z', snapshotId: randomUUID(), snapshotCreated: true,
  receivedRecords: 1, sourceCompleteness: 'unknown', sourceVersion: 'unavailable',
  snapshotSemantics: 'immutable_observation_not_latest', deletionDetection: 'not_available' } as const;

test('sleep task binding and receipt replay preserve existing files and omit the credential', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hab-sleep-files-'));
  try {
    await bindSleepUploadDestination(directory, config); await saveSleepUploadReceipt(directory, receipt);
    const binding = await readFile(join(directory, 'destination.json'), 'utf8');
    const saved = await readFile(join(directory, 'receipt.json'), 'utf8');
    assert.deepEqual(JSON.parse(binding), { baseUrl: config.baseUrl, ownerId: config.ownerId, sourceId: config.sourceId });
    assert(!binding.includes(config.token));
    await bindSleepUploadDestination(directory, { ...config, token: 't'.repeat(43) });
    await saveSleepUploadReceipt(directory, receipt);
    assert.equal(await readFile(join(directory, 'destination.json'), 'utf8'), binding);
    assert.equal(await readFile(join(directory, 'receipt.json'), 'utf8'), saved);
    await assert.rejects(bindSleepUploadDestination(directory, { ...config, ownerId: randomUUID() }), /upload_destination_changed/);
    await assert.rejects(saveSleepUploadReceipt(directory, { ...receipt, snapshotId: randomUUID() }), /uploaded_receipt_not_saved/);
    assert.equal(await readFile(join(directory, 'destination.json'), 'utf8'), binding);
    assert.equal(await readFile(join(directory, 'receipt.json'), 'utf8'), saved);
  } finally {
    await unlink(join(directory, 'destination.json')); await unlink(join(directory, 'receipt.json')); await rmdir(directory);
  }
});

test('unreadable, malformed and oversized existing task files retain the specific upload outcome', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hab-sleep-files-'));
  try {
    for (const [name, save, failure] of [
      ['destination.json', () => bindSleepUploadDestination(directory, config), 'upload_destination_changed'],
      ['receipt.json', () => saveSleepUploadReceipt(directory, receipt), 'uploaded_receipt_not_saved'],
    ] as const) {
      const path = join(directory, name);
      await mkdir(path); // Portable reproduction of EEXIST followed by an unreadable JSON path.
      try { await assert.rejects(save(), error => error instanceof Error && error.message === failure); }
      finally { await rmdir(path); }
      for (const damaged of ['not-json', 'x'.repeat(65537)]) {
        await writeFile(path, damaged, { flag: 'wx' });
        try {
          await assert.rejects(save(), error => error instanceof Error && error.message === failure);
          assert.equal(await readFile(path, 'utf8'), damaged, 'never overwrite conflicting evidence');
        } finally { await unlink(path); }
      }
    }
  } finally { await rmdir(directory); }
});

test('new task-file write failures retain the specific upload outcome without creating a replacement task', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'hab-sleep-files-'));
  try {
    const missing = join(directory, 'not-created');
    await assert.rejects(bindSleepUploadDestination(missing, config), /upload_destination_changed/);
    await assert.rejects(saveSleepUploadReceipt(missing, receipt), /uploaded_receipt_not_saved/);
  } finally { await rmdir(directory); }
});
