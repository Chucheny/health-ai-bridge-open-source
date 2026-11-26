// Pure synthetic activity summary following the public frontend's field lookup, not a live response.
export function syntheticWorkoutSummary() {
  return { dataSummary: [
    { dataTypeName: 'com.huawei.continuous.steps.total', value: [{ fieldName: 'steps', integerValue: 2345 }] },
    { dataTypeName: 'com.huawei.continuous.exercise_heart_rate.statistics', value: [
      { fieldName: 'avg', floatValue: 123.5 }, { fieldName: 'min', integerValue: 81 }, { fieldName: 'max', floatValue: 165 },
    ] },
  ], futureSummary: { syntheticUnknown: 'retain-original' } };
}
