import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readFileSync } from 'node:fs';
import { classifyTrainingCampActivity, inspectTrainingCampActivities, inspectTrainingCampSleep, parseTrainingCampJson } from '../trainingcamp-semantics.mts';

const value = (fieldName: string, integerValue: number) => ({ fieldName, integerValue });
const sleep = (code: number, minutes = 0) => ({ value: [value('sleep_type', code), value('all_sleep_time', minutes)] });
const inspect = (healthRecords: unknown[]) => inspectTrainingCampSleep({ healthRecords });

test('source sleep codes separate main sleep and naps without duration or clock heuristics', () => {
  const result = inspect([sleep(1, 20), sleep(2, 420), sleep(3, 180), sleep(99, 500), { value: [] }]);
  assert.deepEqual(result.counts, { sourceRecords: 5, mainSleepRecords: 2, napRecords: 1, unclassifiedRecords: 2 });
  assert.deepEqual(result.records.map(r => r.sleepKind), ['main_sleep', 'main_sleep', 'nap', 'unknown', 'unknown']);
  assert.equal(result.records[0].reportedSleepMinutes, 20);
  assert.equal(result.records[4].reportedSleepMinutes, null);
  assert.equal(result.records[4].stageDataState, 'not_provided');
  assert.equal(inspect([sleep(3)]).records[0].reportedSleepMinutes, 0);
  assert.equal(result.sourceCompleteness, 'unknown');
});

test('cross-midnight sessions, multiple nights and original field/time-zone metadata remain intact', () => {
  const record = { ...sleep(1, 420), timeZone: '+0800', startTime: '1767283200123456789', endTime: '1767312000987654321' };
  const result = inspect([record, record, sleep(2, 400)]);
  assert.equal(result.records.length, 3); // No last-night-only selection or guessed deduplication.
  assert.equal(result.records[0].rawStartTime, record.startTime);
  assert.equal(result.records[0].rawEndTime, record.endTime);
  assert.equal(result.records[0].sourceTimeZone, '+0800');
  assert.deepEqual(result.records[0].fields, record.value);
});

test('unrecognized source value fields and units survive offline adaptation without changing classification', () => {
  const fields = [value('sleep_type', 3), { fieldName: 'future_value',
    syntheticFutureValue: { exact: '12345678901234567890', unit: 'source_unit' } }];
  const input = { value: fields, subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
    { startTime: '1767283200123456789', endTime: '1767285000123456789', value: [
      { fieldName: 'future_stage', integerValue: 99, unit: 'source_stage_unit', futureDetails: ['a', 'b'] },
    ] },
  ] } } };
  const before = structuredClone(input);
  const record = inspect([input]).records[0];
  assert.equal(record.sleepKind, 'nap');
  assert.deepEqual(record.fields, fields);
  assert.equal(record.stages[0].stageKind, 'unknown');
  assert.deepEqual(record.stages[0].fields, input.subData['com.huawei.continuous.sleep.fragment'].samplePoints[0].value);
  assert.deepEqual(input, before);
});

test('all source stages retain order, exact nanoseconds and unknown codes without subsampling', () => {
  const stages = Array.from({ length: 125 }, (_, i) => ({ startTime: String(1767283200123456789n + BigInt(i) * 10n),
    endTime: String(1767283200123456799n + BigInt(i) * 10n), value: [value('sleep_stage', i % 5 + 1)] }));
  const result = inspect([{ ...sleep(1), subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: stages } } }]);
  assert.equal(result.records[0].stages.length, 125);
  assert.equal(result.records[0].stageDataState, 'provided_points');
  assert.deepEqual(result.records[0].stages.slice(0, 5).map(s => s.stageKind), ['light', 'rem', 'deep', 'awake', 'unknown']);
  assert.equal(result.records[0].stages[124].startTimeNs, stages[124].startTime);
  assert.deepEqual(result.records[0].stages[4].fields, stages[4].value);
});

test('sleep and fragment source IDs/type names survive normalization and mismatched types are rejected', () => {
  const source = { ...sleep(1), id: 'synthetic-sleep-id', dataTypeName: 'com.huawei.health.record.sleep',
    originalDataCollectorId: 'synthetic-session-collector', subData: { 'com.huawei.continuous.sleep.fragment': {
      samplePoints: [{ startTime: '1767283200123456789', endTime: '1767283201123456789',
        dataTypeName: 'com.huawei.continuous.sleep.fragment', originalDataCollectorId: 'synthetic-stage-collector',
        value: [value('sleep_stage', 1)] }],
    } } };
  const result = inspect([source]).records[0];
  assert.equal(result.sourceRecordId, source.id);
  assert.equal(result.sourceDataType, source.dataTypeName);
  assert.equal(result.sourceCollectorId, source.originalDataCollectorId);
  assert.equal(result.stages[0].sourceDataType, 'com.huawei.continuous.sleep.fragment');
  assert.equal(result.stages[0].sourceCollectorId, 'synthetic-stage-collector');
  assert.throws(() => inspect([{ ...source, dataTypeName: 'com.huawei.unrelated' }]), /^Error: invalid_trainingcamp_data$/);
  const stage = source.subData['com.huawei.continuous.sleep.fragment'].samplePoints[0];
  assert.throws(() => inspect([{ ...source, subData: { 'com.huawei.continuous.sleep.fragment': {
    samplePoints: [{ ...stage, dataTypeName: 'com.huawei.unrelated' }],
  } } }]), /^Error: invalid_trainingcamp_data$/);
});

test('raw JSON unsafe integers retain original digits; already-rounded objects and exponential unsafe values are rejected', () => {
  const json = '{"healthRecords":[{"startTime":1767283200123456789,"endTime":1767312000987654321,"value":[]}]}';
  const result = inspectTrainingCampSleep(parseTrainingCampJson(json));
  assert.equal(result.records[0].rawStartTime, '1767283200123456789');
  assert.equal(result.records[0].rawEndTime, '1767312000987654321');
  assert.throws(() => inspect([{ startTime: Number(1767283200123456789n), value: [] }]), /^Error: invalid_trainingcamp_data$/);
  for (const text of ['1.767283200123456789e18', '1e400', 'not-json-private-sentinel']) {
    assert.throws(() => parseTrainingCampJson(text), /^Error: invalid_trainingcamp_data$/);
  }
  assert.throws(() => parseTrainingCampJson('{"integerValue":1.00000000000000001}'), /^Error: invalid_trainingcamp_data$/);
});

test('ambiguous classification, missing response collection, bad durations and invalid stages fail without echoing input', () => {
  const cases = [{}, { healthRecords: null }, { healthRecords: [{ value: [value('sleep_type', 1), value('sleep_type', 3)] }] },
    { healthRecords: [sleep(1, -1)] }, { healthRecords: [{ value: [{ fieldName: 'sleep_type', stringValue: 'private-sentinel' }] }] },
    { healthRecords: [{ ...sleep(1), subData: { 'com.huawei.continuous.sleep.fragment': { samplePoints: [
      { startTime: '20', endTime: '10', value: [] },
    ] } } }] }];
  for (const input of cases) assert.throws(() => inspectTrainingCampSleep(input), /^Error: invalid_trainingcamp_data$/);
  const empty = inspect([]);
  assert.equal(empty.counts.sourceRecords, 0);
  assert.equal(empty.sourceCompleteness, 'unknown');
});

test('source-specific activity types keep running, cycling and swimming subtypes separate', () => {
  const codes = [13, 30, 52, 56, 57, 79, 82, 83, 97, 129, 130, 161];
  assert.deepEqual(codes.map(c => classifyTrainingCampActivity(c).category), ['outdoor_cycling', 'hiking', 'rock_climbing',
    'outdoor_running', 'indoor_running', 'strength_training', 'open_water_swimming', 'pool_swimming', 'indoor_cycling', 'mountain_climbing', 'trail_running', 'marathon']);
  assert.equal(classifyTrainingCampActivity('56').sourceType, '56');
  for (const code of [999999, 'track-running-unverified', '056', '__proto__']) {
    const result = classifyTrainingCampActivity(code);
    assert.equal(result.sourceType, code); assert.equal(result.category, 'unknown'); assert.equal(result.label, null);
  }
  for (const code of [-1, 1.5, null, {}]) assert.throws(() => classifyTrainingCampActivity(code), /^Error: invalid_trainingcamp_data$/);
});

test('activity response keeps source types, millisecond times and original summaries without guessed units or deduplication', () => {
  const input = parseTrainingCampJson(readFileSync(new URL('./fixtures/trainingcamp-activities.synthetic.json', import.meta.url), 'utf8')) as unknown[];
  const before = structuredClone(input);
  const result = inspectTrainingCampActivities([...input, input[0]]);
  assert.deepEqual(result.counts, { sourceRecords: 3, unclassifiedRecords: 1 });
  assert.equal(result.records[0].startTimeMs, '1767225600000');
  assert.equal(result.records[0].endTimeMs, '1767227400000');
  assert.equal(result.records[0].sourceTimeZone, '+0800');
  assert.equal(result.records[0].rawActiveTime, '1800');
  assert.equal(result.records[0].activeTimeUnit, 'unverified');
  assert.deepEqual(result.records[0].sourceSummary, (input[0] as { activitySummary: unknown }).activitySummary);
  assert.equal(result.records[1].category, 'unknown');
  assert.equal(result.records[1].rawActiveTime, null);
  assert.equal(result.records[1].sourceSummary, null);
  assert.equal(result.sourceCompleteness, 'unknown');
  assert.equal(result.scope, 'provided_response_only');
  result.records[0].sourceSummary!.futureField = 'output-only';
  assert.deepEqual(input, before);
});

test('activity adapter rejects response wrappers, unsafe or reversed times without disclosing private inputs', () => {
  const record = { id: 'synthetic-private-sentinel', startTime: 1000, endTime: 2000, activityType: 56 };
  for (const input of [{ activityRecords: [record] }, [ { ...record, startTime: 2000 } ],
    [{ ...record, startTime: -1 }], [{ ...record, endTime: Number.MAX_SAFE_INTEGER + 1 }],
    [{ ...record, startTime: '1.5' }], [{ ...record, activeTime: -1 }],
    [{ ...record, activityType: null }], [{ ...record, id: '' }]]) {
    assert.throws(() => inspectTrainingCampActivities(input), /^Error: invalid_trainingcamp_data$/);
  }
  const empty = inspectTrainingCampActivities([]);
  assert.equal(empty.counts.sourceRecords, 0);
  assert.equal(empty.sourceCompleteness, 'unknown');
});

test('local diagnostic accepts provided response only and never prints source health fields or credentials', () => {
  const cli = new URL('../trainingcamp-sleep-diagnostic.mts', import.meta.url);
  const result = spawnSync(process.execPath, [fileURLToPath(cli)], {
    input: JSON.stringify({ healthRecords: [{ value: [value('sleep_type', 3),
      { fieldName: 'private-sentinel', stringValue: 'synthetic-private-value' }] }], token: 'synthetic-token' }), encoding: 'utf8',
  });
  assert.equal(result.status, 0);
  const output = JSON.parse(result.stdout);
  assert.equal(output.counts.napRecords, 1); assert.equal(output.liveReadingVerified, false);
  assert(!result.stdout.includes('synthetic')); assert(!result.stdout.includes('private-sentinel')); assert.equal(result.stderr, '');
  const invalid = spawnSync(process.execPath, [fileURLToPath(cli)], { input: 'synthetic-secret', encoding: 'utf8' });
  assert.equal(invalid.status, 1); assert.equal(invalid.stdout, '');
  assert.deepEqual(JSON.parse(invalid.stderr), { error: 'invalid_trainingcamp_input' });
});
