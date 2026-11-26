import { test } from 'node:test';
import assert from 'node:assert/strict';
import { trainingCampWorkoutMetrics } from '../trainingcamp-workout-metrics.mts';
import { syntheticWorkoutSummary } from './support/trainingcamp-workout-fixture.mts';

test('workout metrics expose only the observed source fields with units and per-exercise provenance', () => {
  const input = syntheticWorkoutSummary(), original = structuredClone(input), metrics = trainingCampWorkoutMetrics(input);
  assert.equal(metrics.scope, 'exercise_session_only');
  assert.deepEqual(metrics.steps, { state: 'reported', value: 2345, unit: 'steps',
    sourceDataType: 'com.huawei.continuous.steps.total', sourceField: 'steps', valueType: 'integerValue' });
  assert.deepEqual(Object.values(metrics.heartRate).map(m => [m.state, m.value, m.unit]),
    [['reported', 123.5, 'BPM'], ['reported', 81, 'BPM'], ['reported', 165, 'BPM']]);
  assert.deepEqual(input, original);
  // Resting heart rate, cadence and similarly named future fields cannot masquerade as the selected metric.
  const unrelated = { dataSummary: [
    { dataTypeName: 'com.huawei.instantaneous.resting_heart_rate', value: [{ fieldName: 'avg', floatValue: 60 }] },
    { dataTypeName: 'com.huawei.continuous.steps.rate.statistics', value: [{ fieldName: 'steps', integerValue: 180 }] },
  ] };
  assert.equal(trainingCampWorkoutMetrics(unrelated).steps.state, 'not_reported');
  assert.equal(trainingCampWorkoutMetrics(unrelated).heartRate.average.state, 'not_reported');
});

test('absent workout metrics remain unknown, while a source-reported zero step count is retained', () => {
  for (const summary of [undefined, null, {}, { dataSummary: [] }, { dataSummary: [{ unrelated: true }] }]) {
    const m = trainingCampWorkoutMetrics(summary);
    assert.equal(m.steps.state, 'not_reported'); assert.equal(m.steps.value, null);
    assert(Object.values(m.heartRate).every(field => field.state === 'not_reported' && field.value === null));
  }
  const input = syntheticWorkoutSummary(); input.dataSummary[0].value[0].integerValue = 0;
  assert.equal(trainingCampWorkoutMetrics(input).steps.value, 0);
  assert.equal(trainingCampWorkoutMetrics(input).steps.state, 'reported');
});

test('duplicate groups, duplicate fields and multiple numeric representations never select or add arbitrary values', () => {
  const original = syntheticWorkoutSummary();
  const duplicateGroup = structuredClone(original); duplicateGroup.dataSummary.push(structuredClone(duplicateGroup.dataSummary[0]));
  assert.equal(trainingCampWorkoutMetrics(duplicateGroup).steps.state, 'ambiguous');
  assert.equal(trainingCampWorkoutMetrics(duplicateGroup).heartRate.average.value, 123.5);
  const duplicateField = structuredClone(original); duplicateField.dataSummary[1].value.push({ fieldName: 'avg', integerValue: 124 });
  assert.equal(trainingCampWorkoutMetrics(duplicateField).heartRate.average.state, 'ambiguous');
  const dualValue: any = structuredClone(original); dualValue.dataSummary[0].value[0].floatValue = 2345;
  assert.equal(trainingCampWorkoutMetrics(dualValue).steps.state, 'ambiguous');
  for (const input of [duplicateGroup, duplicateField, dualValue]) {
    assert.equal(trainingCampWorkoutMetrics(input).steps.state === 'ambiguous' ? trainingCampWorkoutMetrics(input).steps.value
      : trainingCampWorkoutMetrics(input).heartRate.average.value, null);
  }
});

test('malformed, unsafe, negative, fractional-count and unit-mismatched metrics stay in raw data without producing a usable value', () => {
  for (const field of [ { fieldName: 'steps', integerValue: -1 }, { fieldName: 'steps', floatValue: 1.5 },
    { fieldName: 'steps', integerValue: Number.MAX_SAFE_INTEGER + 1 }, { fieldName: 'steps', floatValue: NaN },
    { fieldName: 'steps', stringValue: '2345' }, { fieldName: 'steps', longValue: '9007199254740993' },
    { fieldName: 'steps', integerValue: null }, { fieldName: 'steps', floatValue: Infinity },
    { fieldName: 'steps', integerValue: 2345, unit: 'km' } ]) {
    const input: any = syntheticWorkoutSummary(); input.dataSummary[0].value = [field];
    const before = structuredClone(input), m = trainingCampWorkoutMetrics(input);
    assert.equal(m.steps.state, 'invalid'); assert.equal(m.steps.value, null); assert.deepEqual(input, before);
  }
  for (const summary of ['synthetic-private', [], { dataSummary: {} }, { dataSummary: [
    { dataTypeName: 'com.huawei.continuous.steps.total', value: {} },
  ] }]) assert.equal(trainingCampWorkoutMetrics(summary).steps.state, 'invalid');
  const input: any = syntheticWorkoutSummary(); input.dataSummary[1].value[0].floatValue = 0;
  assert.equal(trainingCampWorkoutMetrics(input).heartRate.average.state, 'invalid');
});
