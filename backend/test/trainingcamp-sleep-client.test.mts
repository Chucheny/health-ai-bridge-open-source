import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { mkdtemp, readFile, rmdir, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { listSleepSnapshots, parseSleepClientConfig, parseSleepUploadJob, prepareSleepUpload,
  sleepSnapshotMcpArgs, uploadSleepJob } from '../trainingcamp-sleep-client.mts';

const window = { start: '2026-01-01T00:00:00Z', end: '2026-01-02T00:00:00Z' };
const config = { schemaVersion: 1, baseUrl: 'https://bridge.invalid', ownerId: randomUUID(), sourceId: randomUUID(),
  token: 's'.repeat(43), allowedTypes: ['SleepSessionRecord'] };
function capture(): any {
  return { schemaVersion: 1, source: 'huawei_trainingcamp', kind: 'sleep', requestedWindow: window,
    apiRequest: { startTimeNs: '1767225600000000000', endTimeNs: '1767311999999999999' },
    capturedAt: '2026-01-02T00:00:00Z', sourceCompleteness: 'unknown', rawResponse: JSON.stringify({ healthRecords: [
      { id: 'synthetic-session', startTime: '1767229200000000123', endTime: '1767232800000000123',
        value: [{ fieldName: 'sleep_type', integerValue: 3 }, { fieldName: 'all_sleep_time', integerValue: 25 }] },
    ] }) };
}
const receipt = (job: ReturnType<typeof prepareSleepUpload>) => ({ batchId: job.preview.batchId,
  source: 'huawei_trainingcamp', committed: true, committedAt: '2026-01-02T00:00:00Z', snapshotId: randomUUID(),
  snapshotCreated: true, receivedRecords: 1, sourceCompleteness: 'unknown', sourceVersion: 'unavailable',
  snapshotSemantics: 'immutable_observation_not_latest', deletionDetection: 'not_available' });

test('offline upload preparation enforces independent dates and wire size, preserves original capture, and recomputes saved preview', () => {
  const original = capture(), job = prepareSleepUpload(original, window), before = JSON.stringify(original);
  assert.equal(job.preview.counts.napRecords, 1); assert.equal(job.preview.requestBytes, Buffer.byteLength(job.body));
  assert.equal(job.preview.counts.sourceStages, 0);
  assert.equal(JSON.parse(job.body).capture.rawResponse, original.rawResponse);
  assert.equal(JSON.stringify(original), before); assert(!job.body.includes(config.token));
  const saved = structuredClone(job); saved.preview.counts.napRecords = 99; saved.preview.counts.sourceStages = 99;
  assert.deepEqual(parseSleepUploadJob(saved), job);
  const { sourceStages: _oldPreviewOmission, ...legacyCounts } = job.preview.counts;
  assert.deepEqual(parseSleepUploadJob({ ...job, preview: { ...job.preview, counts: legacyCounts } }), job);
  assert.throws(() => parseSleepUploadJob({ ...job, body: job.body + ' ' }), /invalid_sleep_upload_job/);
  assert.throws(() => prepareSleepUpload(original, { start: '2026-01-01T02:00:00Z', end: window.end }), /invalid_sleep_upload_job/);
  const huge = capture(), raw = JSON.parse(huge.rawResponse);
  raw.healthRecords[0].value[0].extra = 'x'.repeat(2 * 1024 * 1024); huge.rawResponse = JSON.stringify(raw);
  assert.throws(() => prepareSleepUpload(huge, window), /invalid_sleep_upload_job/);
});

test('upload configuration accepts only explicit HTTPS Bridge device configuration with sleep access', () => {
  assert.equal(parseSleepClientConfig(config).baseUrl, config.baseUrl);
  for (const bad of [{ ...config, baseUrl: 'http://bridge.invalid' }, { ...config, baseUrl: 'https://user:secret@bridge.invalid' },
    { ...config, baseUrl: 'https://bridge.invalid/?token=secret' }, { ...config, baseUrl: 'https://bridge.invalid/elsewhere' },
    { ...config, baseUrl: 'https://bridge.invalid/#hash' }, { ...config, allowedTypes: ['StepsRecord'] },
    { ...config, cookies: 'synthetic-private' }, { ...config, token: 'Huawei sign-in token' }]) {
    assert.throws(() => parseSleepClientConfig(bad), error => error instanceof Error && error.message === 'invalid_sleep_client_config');
  }
});

test('upload requires explicit confirmation, sends original prepared bytes once, and neither exports token nor accepts a mismatched receipt', async () => {
  const job = prepareSleepUpload(capture(), window); let calls = 0;
  const expected = receipt(job);
  const fetcher: typeof fetch = async (url, init) => {
    calls++; assert.equal(String(url), config.baseUrl + '/api/health/trainingcamp/sleep/import');
    assert.equal(init!.redirect, 'error'); assert.equal(init!.credentials, 'omit'); assert.equal(init!.cache, 'no-store');
    assert.equal(init!.referrerPolicy, 'no-referrer'); assert.equal(init!.method, 'POST'); assert.equal(init!.body, job.body);
    assert.equal(new Headers(init!.headers).get('authorization'), 'Bearer ' + config.token);
    assert(init!.signal); return Response.json(expected);
  };
  await assert.rejects(uploadSleepJob(job, config, async () => false, fetcher), /upload_cancelled/); assert.equal(calls, 0);
  const response = await uploadSleepJob(job, config, async preview => {
    assert.equal(preview.destination, config.baseUrl); assert(!JSON.stringify(preview).includes(config.token)); return true;
  }, fetcher);
  assert.equal(calls, 1); assert.deepEqual(response, expected);
  for (const patch of [{ batchId: randomUUID() }, { receivedRecords: 0 }, { committed: false }, { arbitrarySecret: 'synthetic-private' }]) {
    await assert.rejects(uploadSleepJob(job, config, async () => true, async () => Response.json({ ...expected, ...patch })),
      error => error instanceof Error && error.message === 'bridge_outcome_unknown');
  }
});

test('transport has no automatic retry, ignores remote errors, and bounds malformed or oversized response bodies', async () => {
  const job = prepareSleepUpload(capture(), window); let calls = 0;
  await assert.rejects(uploadSleepJob(job, config, async () => true, async () => {
    calls++; throw new Error('synthetic-private ' + config.token);
  }), error => error instanceof Error && error.message === 'bridge_outcome_unknown');
  assert.equal(calls, 1);
  for (const [status, expected] of [[401, 'bridge_rejected_401'], [429, 'bridge_rejected_429'], [503, 'bridge_outcome_unknown']] as const) {
    await assert.rejects(uploadSleepJob(job, config, async () => true,
      async () => Response.json({ error: config.token }, { status })), error => error instanceof Error && error.message === expected);
  }
  for (const response of [new Response('<html>synthetic-private</html>'), Response.json({ extra: 'x'.repeat(65537) }),
    new Response('not-json', { headers: { 'content-type': 'application/json' } })]) {
    await assert.rejects(uploadSleepJob(job, config, async () => true, async () => response), /bridge_outcome_unknown/);
  }
});

test('snapshot selection uses only validated explicit choices and rejects out-of-window catalogs before showing them', async () => {
  const snapshot = { snapshotId: randomUUID(), sourceId: randomUUID(), requestedWindow: window,
    captureReportedAt: '2026-01-02T00:00:00Z', importedAt: '2026-01-02T01:00:00Z', sessionCount: 1,
    sourceCompleteness: 'unknown', sourceVersion: 'unavailable' };
  let calls = 0;
  const fetcher: typeof fetch = async (url, init) => {
    calls++; const u = new URL(String(url)); assert.equal(u.searchParams.get('start'), window.start);
    assert.equal(u.searchParams.get('end'), window.end); assert.equal(init!.method, 'GET');
    assert.equal(init!.body, undefined); return Response.json({ source: 'huawei_trainingcamp', snapshots: [snapshot], nextCursor: null,
      semantics: 'remote arbitrary text that is not forwarded' });
  };
  const catalog = await listSleepSnapshots(config, window, undefined, fetcher); assert.equal(calls, 1);
  assert(!JSON.stringify(catalog).includes('arbitrary text'));
  const chosen = sleepSnapshotMcpArgs(catalog.snapshots[0]);
  assert.equal(chosen.health_records.sleepStages, 'paged'); assert.equal(chosen.health_summary.snapshot, snapshot.snapshotId);
  assert.deepEqual(chosen.health_records.start, window.start); assert(!JSON.stringify(chosen).includes(config.token));
  await assert.rejects(listSleepSnapshots(config, { start: window.start, end: '2026-03-01T00:00:00Z' }, undefined, fetcher), /invalid_sleep_catalog_query/);
  assert.equal(calls, 1);
  for (const snapshots of [[{ ...snapshot, requestedWindow: { start: '2025-12-31T00:00:00Z', end: window.end } }],
    [snapshot, snapshot], [{ ...snapshot, sessionCount: -1 }]]) {
    await assert.rejects(listSleepSnapshots(config, window, undefined,
      async () => Response.json({ source: 'huawei_trainingcamp', snapshots, nextCursor: null })), /bridge_outcome_unknown/);
  }
});

test('CLI upload/select refuse noninteractive invocation before opening files or making requests', () => {
  const script = new URL('../trainingcamp-sleep-command.mts', import.meta.url);
  for (const args of [['upload', randomUUID(), 'nonexistent-config'], ['select', 'nonexistent-config', window.start, window.end]]) {
    const out = spawnSync(process.execPath, [fileURLToPath(script), ...args], { encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 1); assert.equal(out.stdout, '');
    assert.equal(JSON.parse(out.stderr).error, 'interactive_terminal_required');
    assert(!out.stderr.includes('nonexistent-config'));
  }
});

test('CLI prepare runs offline, persists a replayable private job and leaves its synthetic source untouched', async () => {
  const temporary = await mkdtemp(join(tmpdir(), 'hab-sleep-client-')), source = join(temporary, 'synthetic-capture.json');
  const original = JSON.stringify(capture()); let jobPath: string | undefined, directory: string | undefined;
  try {
    await writeFile(source, original, { flag: 'wx' });
    const out = spawnSync(process.execPath, [fileURLToPath(new URL('../trainingcamp-sleep-command.mts', import.meta.url)),
      'prepare', source, window.start, window.end], { encoding: 'utf8', timeout: 10000 });
    assert.equal(out.status, 0, out.stderr); assert.equal(out.stderr, '');
    const preview = JSON.parse(out.stdout); assert.equal(preview.status, 'prepared_locally_not_uploaded');
    assert.match(preview.jobId, /^[a-f0-9-]{36}$/);
    directory = fileURLToPath(new URL('../../private/trainingcamp-imports/' + preview.jobId + '/', import.meta.url));
    jobPath = join(directory, 'job.json');
    const persisted = parseSleepUploadJob(JSON.parse(await readFile(jobPath, 'utf8')));
    assert.equal(persisted.preview.batchId, preview.batchId);
    assert.equal(JSON.parse(persisted.body).capture.rawResponse, capture().rawResponse);
    assert.equal(await readFile(source, 'utf8'), original);
    assert(!JSON.stringify(persisted).includes(config.token));
  } finally {
    if (jobPath) await unlink(jobPath);
    if (directory) await rmdir(directory); // Only the new UUID directory, no recursive deletion.
    await unlink(source); await rmdir(temporary);
  }
});
