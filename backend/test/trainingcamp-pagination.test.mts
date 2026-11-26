import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Database } from '../database.mts';
import { inspectTrainingCampIntegrity } from '../trainingcamp-integrity.mts';
import { auditWindow, createSyntheticFixture, syntheticActivityBatch, syntheticSleepBatch } from './support/trainingcamp-fixture.mts';

test('activity REST and MCP cursors traverse numeric keys across digit boundaries without gaps or duplicates', async () => {
  const c = await createSyntheticFixture();
  try {
    const records = Array.from({ length: 25 }, () => syntheticActivityBatch().records[0]);
    assert.equal((await c.request('trainingcamp/import', { ...syntheticActivityBatch(), records })).status, 200);
    const expected = [c.activityBatch.records[0].id, ...records.map(r => r.id)];
    for (const transport of ['REST', 'MCP']) for (const limit of [1, 7, 20]) {
      const actual: string[] = []; let cursor: string | null = null, pages = 0;
      do {
        const args: Record<string, string> = { ...auditWindow, source: 'huawei_trainingcamp', type: 'ExerciseSessionRecord', limit: String(limit), ...(cursor ? { cursor } : {}) };
        let response;
        if (transport === 'REST') {
          const result = await c.request('records?' + new URLSearchParams(args));
          assert.equal(result.status, 200); response = result.body;
        } else {
          const result = await c.call('health_records', { ...args, limit });
          assert.notEqual(result.isError, true); response = JSON.parse(result.content[0].text);
        }
        actual.push(...response.records.map((r: any) => r.record.sourceRecordId)); cursor = response.nextCursor;
        assert(++pages <= expected.length);
      } while (cursor !== null);
      assert.deepEqual(actual, expected, `${transport}, limit=${limit}: every retained record exactly once in numeric key order`);
    }
  } finally { await c.pg.close(); }
});

test('sleep full-session and stage-fragment cursors retain all sessions across digit boundaries through REST and MCP', async () => {
  const c = await createSyntheticFixture();
  try {
    const batch = syntheticSleepBatch(450, Array.from({ length: 20 }, (_, i) => [1, 3, 99][i % 3]));
    // Keep complete-session mode inside its byte budget while still requiring >200-stage paging.
    const raw = JSON.parse(batch.capture.rawResponse);
    for (const record of raw.healthRecords) for (const stage of record.subData['com.huawei.continuous.sleep.fragment'].samplePoints) {
      stage.value[0].syntheticExtra = 'x';
    }
    batch.capture.rawResponse = JSON.stringify(raw);
    const imported = await c.request('trainingcamp/sleep/import', batch); assert.equal(imported.status, 200);
    const expected = (await c.pg.query<any>('SELECT record_key::text AS key,payload FROM health_bridge.trainingcamp_sleep_records WHERE snapshot_id=$1 ORDER BY ordinal', [imported.body.snapshotId])).rows;
    for (const transport of ['REST', 'MCP']) for (const paged of [false, true]) {
      const sessions: any[] = [], keys: string[] = []; let cursor: string | null = null, pages = 0;
      do {
        const args: Record<string, string> = { ...auditWindow, source: 'huawei_trainingcamp', type: 'SleepSessionRecord',
          snapshot: imported.body.snapshotId, limit: '7', ...(paged ? { sleepStages: 'paged' } : {}), ...(cursor ? { cursor } : {}) };
        let response;
        if (transport === 'REST') {
          const result = await c.request('records?' + new URLSearchParams(args)); assert.equal(result.status, 200); response = result.body;
        } else {
          const result = await c.call('health_records', { ...args, limit: 7 }); assert.notEqual(result.isError, true); response = JSON.parse(result.content[0].text);
        }
        for (const item of response.records) {
          if (!paged) { sessions.push(item.record); continue; }
          if (item.stagePage.startIndex === 0) { sessions.push({ ...item.record, stages: [] }); keys.push(item.sessionKey); }
          assert.equal(item.sessionKey, keys[keys.length - 1]);
          const current = sessions[sessions.length - 1];
          assert.equal(item.stagePage.startIndex, current.stages.length);
          current.stages.push(...item.record.stages);
          assert.equal(item.stagePage.sessionComplete, current.stages.length === item.stagePage.total);
        }
        cursor = response.nextCursor; assert(++pages <= 30);
      } while (cursor !== null);
      assert.deepEqual(sessions, expected.map(r => r.payload), `${transport}, paged=${paged}: all sessions and original stages exactly once`);
      if (paged) assert.deepEqual(keys, expected.map(r => r.key));
    }
  } finally { await c.pg.close(); }
});

test('integrity audit scans each numeric activity key once across its 100-row boundary and detects corruption in previously skipped keys', async () => {
  const c = await createSyntheticFixture();
  try {
    for (const count of [100, 25]) {
      const records = Array.from({ length: count }, () => syntheticActivityBatch().records[0]);
      assert.equal((await c.request('trainingcamp/import', { ...syntheticActivityBatch(), records })).status, 200);
    }
    const visited: string[] = [];
    const db: Database = { transaction: fn => c.db.transaction(sql => fn({ async query(q, p) {
      if (q.startsWith('SELECT payload FROM health_bridge.trainingcamp_activities')) visited.push(String(p![2]));
      return sql.query(q, p);
    } })) };
    assert.equal((await inspectTrainingCampIntegrity(db, c.scope)).status, 'pass');
    assert.deepEqual(visited, Array.from({ length: 126 }, (_, i) => String(i + 1)));
    await c.pg.query("UPDATE health_bridge.trainingcamp_activities SET payload_hash=repeat('0',64) WHERE record_key=8");
    const corrupted = await inspectTrainingCampIntegrity(c.db, c.scope);
    assert.equal(corrupted.complete, true); assert.equal(corrupted.status, 'fail');
    assert.equal(corrupted.checks.activityPayloadHashExact, false);
  } finally { await c.pg.close(); }
});
