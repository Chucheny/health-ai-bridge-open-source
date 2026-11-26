// Read-time interpretation of retained activitySummary only. Never changes import hashes or stored payloads.
// Evidence: Huawei public activities-f99571fb.js / activities-0d5315da.js observed 2026-11-14.
type MetricState = 'reported' | 'not_reported' | 'ambiguous' | 'invalid';
type Unit = 'steps' | 'BPM';
type ObjectValue = Record<string, unknown>;
const object = (value: unknown): value is ObjectValue => value !== null && typeof value === 'object' && !Array.isArray(value);
const stepsType = 'com.huawei.continuous.steps.total';
const heartType = 'com.huawei.continuous.exercise_heart_rate.statistics';

function metric(summary: unknown, dataTypeName: string, fieldName: string, unit: Unit) {
  const result = (state: MetricState, value: number | null = null, valueType?: 'integerValue' | 'floatValue') => ({
    state, value, unit, sourceDataType: dataTypeName, sourceField: fieldName, ...(valueType ? { valueType } : {}),
  });
  if (summary == null) return result('not_reported');
  if (!object(summary)) return result('invalid');
  if (summary.dataSummary === undefined) return result('not_reported');
  if (!Array.isArray(summary.dataSummary)) return result('invalid');
  const groups = summary.dataSummary.filter(item => object(item) && item.dataTypeName === dataTypeName);
  // Never take an arbitrary first match or add duplicate groups/fields together.
  if (groups.length > 1) return result('ambiguous');
  if (!groups.length) return result('not_reported');
  const group = groups[0];
  if (!Array.isArray(group.value)) return result('invalid');
  const fields = group.value.filter((item: unknown) => object(item) && item.fieldName === fieldName);
  if (fields.length > 1) return result('ambiguous');
  if (!fields.length) return result('not_reported');
  const field = fields[0] as ObjectValue;
  const representations = ['integerValue', 'floatValue', 'longValue', 'doubleValue', 'stringValue']
    .filter(key => Object.hasOwn(field, key));
  if (representations.length > 1) return result('ambiguous');
  const valueType = representations[0];
  // The observed frontend reads only floatValue/integerValue here. No coercion or inferred conversion.
  if (valueType !== 'integerValue' && valueType !== 'floatValue') return result('invalid');
  const value = field[valueType];
  if (typeof value !== 'number' || !Number.isFinite(value) || Math.abs(value) > Number.MAX_SAFE_INTEGER ||
      (valueType === 'integerValue' && !Number.isSafeInteger(value)) ||
      (unit === 'steps' ? !Number.isSafeInteger(value) || value < 0 : value <= 0) ||
      (field.unit !== undefined && field.unit !== unit) || (group.unit !== undefined && group.unit !== unit)) {
    return result('invalid');
  }
  return result('reported', value, valueType);
}

export function trainingCampWorkoutMetrics(summary: unknown) {
  return {
    scope: 'exercise_session_only' as const,
    timeScope: 'complete_activity_not_clipped_to_query' as const,
    evidence: 'public_frontend_observation_2026_11_14' as const,
    interpretation: 'Source-reported activity summary, not daily steps, resting heart rate or heart-rate samples. Missing/ambiguous/invalid values are not zero. Never sum overlapping activities or average their heart-rate averages.',
    steps: metric(summary, stepsType, 'steps', 'steps'),
    heartRate: {
      average: metric(summary, heartType, 'avg', 'BPM'),
      minimum: metric(summary, heartType, 'min', 'BPM'),
      maximum: metric(summary, heartType, 'max', 'BPM'),
    },
  };
}
