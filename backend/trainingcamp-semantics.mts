// Offline source adapter. No login, network, database or existing MCP imports.
// Mapping evidence and limitations: docs/TRAININGCAMP_ASSESSMENT.md.
import { z } from 'zod';

export const MAX_TRAININGCAMP_INPUT_BYTES = 8 * 1024 * 1024;
const fragmentType = 'com.huawei.continuous.sleep.fragment';
const sleepDataType = 'com.huawei.health.record.sleep';
const integer = z.number().int().safe();
const sourceInteger = z.union([integer, z.string().regex(/^-?\d{1,30}$/)])
  .transform(value => String(value));
const nanoTime = sourceInteger.refine(value => /^\d+$/.test(value));
const valueSchema = z.object({
  fieldName: z.string().min(1).max(256),
  integerValue: integer.optional(), longValue: sourceInteger.optional(),
  floatValue: z.number().finite().optional(), doubleValue: z.number().finite().optional(),
  stringValue: z.string().max(4096).optional(),
}).passthrough();
const values = z.array(valueSchema).max(128);
const stageSchema = z.object({ startTime: nanoTime, endTime: nanoTime, value: values,
  dataTypeName: z.literal(fragmentType).optional(), dataType: z.literal(fragmentType).optional(),
  originalDataCollectorId: z.string().max(1024).optional(),
})
  .refine(stage => BigInt(stage.startTime) < BigInt(stage.endTime));
const sleepSchema = z.object({
  id: z.string().min(1).max(512).optional(),
  dataTypeName: z.literal(sleepDataType).optional(), dataType: z.literal(sleepDataType).optional(),
  originalDataCollectorId: z.string().max(1024).optional(),
  startTime: sourceInteger.optional(), endTime: sourceInteger.optional(),
  timeZone: z.string().max(64).nullable().optional(), value: values,
  subData: z.object({ [fragmentType]: z.object({
    samplePoints: z.array(stageSchema).max(20_000),
  }).optional() }).optional(),
});
const responseSchema = z.object({ healthRecords: z.array(sleepSchema).max(1000) });

function invalid(): never { throw new Error('invalid_trainingcamp_data'); }

/** Preserve JSON integer source digits before JavaScript rounds nanosecond timestamps. */
export function parseTrainingCampJson(text: string): unknown {
  try {
    if (Buffer.byteLength(text) > MAX_TRAININGCAMP_INPUT_BYTES) return invalid();
    return JSON.parse(text, (key, value: unknown, context?: { source?: string }) => {
      if (typeof value !== 'number') return value;
      if (!Number.isFinite(value)) return invalid();
      if (['startTime', 'endTime', 'longValue', 'integerValue'].includes(key) &&
          context?.source && !/^-?\d+$/.test(context.source)) return invalid();
      if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
        if (!context?.source || !/^-?\d+$/.test(context.source)) return invalid();
        return context.source;
      }
      return value;
    });
  } catch { return invalid(); }
}

/** Counts are source records, not nights; retain every session without deduplication or totals. */
export function inspectTrainingCampSleep(input: unknown) {
  try {
    const parsed = responseSchema.parse(input);
    const records = parsed.healthRecords.map(record => {
      const namedInteger = (name: string) => {
        const matches = record.value.filter(field => field.fieldName === name);
        if (matches.length > 1 || (matches.length === 1 && matches[0].integerValue === undefined)) return invalid();
        return matches[0]?.integerValue ?? null;
      };
      const sourceSleepType = namedInteger('sleep_type');
      const reportedSleepMinutes = namedInteger('all_sleep_time');
      if (reportedSleepMinutes !== null && reportedSleepMinutes < 0) return invalid();
      const sleepKind = sourceSleepType === 1 || sourceSleepType === 2 ? 'main_sleep' as const
        : sourceSleepType === 3 ? 'nap' as const : 'unknown' as const;
      const sourceStages = record.subData?.[fragmentType]?.samplePoints;
      const stages = (sourceStages ?? []).map(stage => {
        // The current frontend reads the first value; retain its raw fields and unknown codes.
        const sourceStageType = stage.value[0]?.integerValue ?? null;
        const stageKind = ({ 1: 'light', 2: 'rem', 3: 'deep', 4: 'awake' } as Record<number, string>)[sourceStageType ?? -1] ?? 'unknown';
        return { startTimeNs: stage.startTime, endTimeNs: stage.endTime,
          sourceStageType, stageKind, fields: stage.value,
          sourceDataType: stage.dataTypeName ?? stage.dataType ?? null,
          sourceCollectorId: stage.originalDataCollectorId ?? null };
      });
      return { sourceSleepType, sleepKind, reportedSleepMinutes,
        sourceRecordId: record.id ?? null,
        sourceDataType: record.dataTypeName ?? record.dataType ?? null,
        sourceCollectorId: record.originalDataCollectorId ?? null,
        sourceTimeZone: record.timeZone ?? null,
        rawStartTime: record.startTime ?? null, rawEndTime: record.endTime ?? null,
        fields: record.value,
        stageDataState: sourceStages === undefined ? 'not_provided' as const
          : sourceStages.length ? 'provided_points' as const : 'provided_empty' as const,
        stages };
    });
    return { schemaVersion: 1, source: 'huawei_trainingcamp' as const,
      classificationBasis: 'public_frontend_observation_2026_11_14' as const,
      sourceCompleteness: 'unknown' as const, scope: 'provided_response_only' as const,
      counts: { sourceRecords: records.length,
        mainSleepRecords: records.filter(r => r.sleepKind === 'main_sleep').length,
        napRecords: records.filter(r => r.sleepKind === 'nap').length,
        unclassifiedRecords: records.filter(r => r.sleepKind === 'unknown').length }, records };
  } catch { return invalid(); }
}

// Training Camp identifiers, not Android Health Connect exercise identifiers.
const activityTypes: Record<string, { category: string; label: string }> = {
  '13': { category: 'outdoor_cycling', label: '户外骑行' },
  '30': { category: 'hiking', label: '徒步' },
  '52': { category: 'rock_climbing', label: '攀岩' },
  '56': { category: 'outdoor_running', label: '户外跑步' },
  '57': { category: 'indoor_running', label: '室内跑步' },
  '79': { category: 'strength_training', label: '力量训练' },
  '82': { category: 'open_water_swimming', label: '开放水域游泳' },
  '83': { category: 'pool_swimming', label: '泳池游泳' },
  '97': { category: 'indoor_cycling', label: '室内骑行' },
  '129': { category: 'mountain_climbing', label: '登山' },
  '130': { category: 'trail_running', label: '越野跑' },
  '161': { category: 'marathon', label: '马拉松' },
};

export function classifyTrainingCampActivity(input: unknown) {
  try {
    const sourceType = z.union([integer.nonnegative(), z.string().min(1).max(64)]).parse(input);
    const key = String(sourceType);
    const known = /^(0|[1-9]\d*)$/.test(key) ? activityTypes[key] : undefined;
    return { source: 'huawei_trainingcamp' as const, sourceType,
      category: known?.category ?? 'unknown', label: known?.label ?? null };
  } catch { return invalid(); }
}

const activityType = z.union([integer.nonnegative(), z.string().min(1).max(64)]);
const milliseconds = sourceInteger.refine(value => /^\d+$/.test(value) &&
  BigInt(value) <= BigInt(Number.MAX_SAFE_INTEGER));
const activitySchema = z.object({
  id: z.string().min(1).max(256), startTime: milliseconds, endTime: milliseconds,
  activityType,
  timeZone: z.string().max(64).nullable().optional(),
  activeTime: sourceInteger.refine(value => BigInt(value) >= 0n).optional(),
  activitySummary: z.record(z.string(), z.unknown()).optional(),
}).refine(record => BigInt(record.startTime) < BigInt(record.endTime));

/** Actual record-query response is an array. Counts do not establish pagination or completeness. */
export function inspectTrainingCampActivities(input: unknown) {
  try {
    const records = z.array(activitySchema).max(10_000).parse(input).map(record => ({
      sourceRecordId: record.id,
      ...classifyTrainingCampActivity(record.activityType),
      startTimeMs: record.startTime, endTimeMs: record.endTime,
      sourceTimeZone: record.timeZone ?? null,
      // activeTime's unit has not been verified; never label it seconds or milliseconds.
      rawActiveTime: record.activeTime ?? null, activeTimeUnit: 'unverified' as const,
      sourceSummary: record.activitySummary === undefined ? null : structuredClone(record.activitySummary),
    }));
    return { schemaVersion: 1, source: 'huawei_trainingcamp' as const,
      sourceCompleteness: 'unknown' as const, scope: 'provided_response_only' as const,
      counts: { sourceRecords: records.length,
        unclassifiedRecords: records.filter(record => record.category === 'unknown').length }, records };
  } catch { return invalid(); }
}
