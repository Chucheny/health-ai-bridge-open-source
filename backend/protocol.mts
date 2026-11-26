import { z } from 'zod';
import { createHash } from 'node:crypto';

export const TYPES = ['HeartRateRecord', 'SleepSessionRecord', 'ExerciseSessionRecord',
  'DistanceRecord', 'SpeedRecord', 'ActiveCaloriesBurnedRecord', 'RestingHeartRateRecord',
  'HeartRateVariabilityRmssdRecord', 'StepsRecord', 'OxygenSaturationRecord',
  'RespiratoryRateRecord', 'WeightRecord', 'BloodPressureRecord', 'BloodGlucoseRecord',
  'BodyTemperatureRecord'] as const;
export const typeSchema = z.enum(TYPES);
export const HEALTH_SYNC_ORIGIN = 'nl.appyhapps.healthsync';
// Explicit single-type reads remain compatible with all fifteen serializers.
export const DEFAULT_ANALYSIS_TYPES = ['HeartRateRecord','RestingHeartRateRecord','HeartRateVariabilityRmssdRecord',
  'OxygenSaturationRecord','SleepSessionRecord','StepsRecord','ExerciseSessionRecord','DistanceRecord',
  'ActiveCaloriesBurnedRecord','SpeedRecord'] as const;
export class ApiError extends Error {
  status: number;
  code: string;
  validationFields?: string[];
  constructor(status: number, code: string, validationFields?: string[]) {
    super(code); this.status = status; this.code = code; this.validationFields = validationFields;
  }
}
const timestamp = z.iso.datetime({ offset: true });
const integer = z.number().int().safe();
const number = z.number().finite();
const label = z.string().max(1024).nullable().optional();
const offset = z.string().regex(/^(Z|[+-](?:0\d|1[0-8]):[0-5]\d(?::[0-5]\d)?)$/).nullable();
const metadata = z.strictObject({
  id: z.string().min(1).max(512), dataOriginPackage: z.string().min(1).max(512),
  lastModifiedTime: timestamp, clientRecordId: label,
  // SDK metadata is a signed Long. Preserve its decimal string, including source
  // sentinel values, rather than rejecting a readable record or rewriting it.
  clientRecordVersion: z.string().regex(/^-?\d{1,19}$/).refine(x => /^-?\d{1,19}$/.test(x) &&
    BigInt(x) >= -9223372036854775808n && BigInt(x) <= 9223372036854775807n),
  recordingMethod: integer,
  device: z.strictObject({ type: integer, manufacturer: label, model: label }).optional(),
});
const interval = { startTime: timestamp, endTime: timestamp, startZoneOffset: offset, endZoneOffset: offset };
const instant = { time: timestamp, zoneOffset: offset };
const heart = z.strictObject({ time: timestamp, beatsPerMinute: integer.min(1).max(300), unit: z.literal('BPM') });
const speed = z.strictObject({ time: timestamp, metersPerSecond: number.min(0).max(1000000) });
const stage = z.strictObject({ startTime: timestamp, endTime: timestamp, stage: integer, stageName: z.string().max(100) });
const recordSchema = z.discriminatedUnion('recordType', [
  z.strictObject({ recordType: z.literal('HeartRateRecord'), metadata, ...interval, samples: z.array(heart).max(20000) }),
  z.strictObject({ recordType: z.literal('SpeedRecord'), metadata, ...interval, samples: z.array(speed).max(20000) }),
  z.strictObject({ recordType: z.literal('SleepSessionRecord'), metadata, ...interval, title: label, notes: label, stages: z.array(stage).max(20000) }),
  z.strictObject({ recordType: z.literal('ExerciseSessionRecord'), metadata, ...interval, title: label, notes: label, exerciseType: integer,
    segments: z.array(z.strictObject({ startTime: timestamp, endTime: timestamp, segmentType: integer, repetitions: integer.min(0) })).max(20000),
    laps: z.array(z.strictObject({ startTime: timestamp, endTime: timestamp, lengthMeters: number.min(0).optional() })).max(20000) }),
  z.strictObject({ recordType: z.literal('DistanceRecord'), metadata, ...interval, value: number.min(0), unit: z.literal('m') }),
  z.strictObject({ recordType: z.literal('ActiveCaloriesBurnedRecord'), metadata, ...interval, value: number.min(0), unit: z.literal('kcal') }),
  z.strictObject({ recordType: z.literal('StepsRecord'), metadata, ...interval, value: integer.min(0), unit: z.literal('steps') }),
  z.strictObject({ recordType: z.literal('RestingHeartRateRecord'), metadata, ...instant, value: integer.min(1).max(300), unit: z.literal('BPM') }),
  z.strictObject({ recordType: z.literal('HeartRateVariabilityRmssdRecord'), metadata, ...instant, value: number.min(0), unit: z.literal('ms (RMSSD)') }),
  z.strictObject({ recordType: z.literal('OxygenSaturationRecord'), metadata, ...instant, value: number.min(0).max(100), unit: z.literal('%') }),
  z.strictObject({ recordType: z.literal('RespiratoryRateRecord'), metadata, ...instant, value: number.min(0), unit: z.literal('breaths/min') }),
  z.strictObject({ recordType: z.literal('WeightRecord'), metadata, ...instant, value: number.min(0), unit: z.literal('kg') }),
  z.strictObject({ recordType: z.literal('BloodPressureRecord'), metadata, ...instant, systolic: number.min(0), diastolic: number.min(0),
    unit: z.literal('mmHg'), bodyPosition: integer, measurementLocation: integer }),
  z.strictObject({ recordType: z.literal('BloodGlucoseRecord'), metadata, ...instant, value: number.min(0), unit: z.literal('mmol/L'),
    specimenSource: integer, mealType: integer, relationToMeal: integer }),
  z.strictObject({ recordType: z.literal('BodyTemperatureRecord'), metadata, ...instant, value: number, unit: z.literal('°C'), measurementLocation: integer }),
]);
export type HealthRecord = z.infer<typeof recordSchema>;
export const batchSchema = z.strictObject({ schemaVersion: z.literal(1), batchId: z.uuid(),
  recordType: typeSchema, sequence: integer.min(1),
  operations: z.array(z.discriminatedUnion('op', [
    z.strictObject({ op: z.literal('upsert'), record: recordSchema }),
    z.strictObject({ op: z.literal('delete'), recordId: z.string().min(1).max(512) }),
  ])).max(100),
});
export type Batch = z.infer<typeof batchSchema>;
const syncReceiptSchema = batchSchema.pick({ batchId: true, recordType: true, sequence: true }).extend({
  contentSha256: z.string().regex(/^[0-9a-f]{64}$/),
});
export type SyncReceiptSelector = z.infer<typeof syncReceiptSchema>;
export function parseSyncReceiptSelector(input: unknown): SyncReceiptSelector {
  const parsed = syncReceiptSchema.safeParse(input);
  if (!parsed.success) throw new ApiError(400, 'invalid_receipt_selector');
  return parsed.data;
}

// Preserve Health Connect Instant nanoseconds; Date is used only for whole seconds.
export function ns(value: string): bigint {
  const match = /^(\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d)(?:\.(\d{1,9}))?(Z|[+-]\d\d:\d\d)$/.exec(value);
  if (!match || !timestamp.safeParse(value).success) throw new ApiError(400, 'invalid_timestamp');
  const milliseconds = Date.parse(match[1] + match[3]);
  if (!Number.isFinite(milliseconds)) throw new ApiError(400, 'invalid_timestamp');
  return BigInt(milliseconds) * 1000000n + BigInt((match[2] ?? '').padEnd(9, '0'));
}
// Keep nanoseconds (including timestamps before the Unix epoch) in derived bounds.
export function instantFromNs(value: string): string {
  const total = BigInt(value);
  const fraction = ((total % 1000000000n) + 1000000000n) % 1000000000n;
  const seconds = (total - fraction) / 1000000000n;
  return new Date(Number(seconds * 1000n)).toISOString().replace(/\.000Z$/, '.' + fraction.toString().padStart(9, '0') + 'Z');
}
export function bounds(record: HealthRecord): [bigint, bigint] {
  return 'startTime' in record ? [ns(record.startTime), ns(record.endTime)] : [ns(record.time), ns(record.time)];
}
function assertSpan(start: string, end: string, lo: bigint, hi: bigint) {
  if (ns(start) < lo || ns(end) > hi || ns(start) >= ns(end)) throw new ApiError(400, 'invalid_time_boundary');
}
export function parseBatch(input: unknown): Batch {
  const parsed = batchSchema.safeParse(input);
  if (!parsed.success) {
    // Static schema field names only: never echo a value, unknown key, raw Zod
    // message, record ID or full request into the response or ordinary logs.
    const safeFields = new Set(('schemaVersion batchId recordType sequence operations op record recordId metadata id dataOriginPackage lastModifiedTime clientRecordId clientRecordVersion recordingMethod device type manufacturer model startTime endTime startZoneOffset endZoneOffset time zoneOffset samples beatsPerMinute unit metersPerSecond stages stage stageName title notes exerciseType segments segmentType repetitions laps lengthMeters value systolic diastolic bodyPosition measurementLocation specimenSource mealType relationToMeal').split(' '));
    const fields = [...new Set(parsed.error.issues.slice(0,8).map(issue=>issue.path.map(part=>typeof part==='number'?'*':safeFields.has(String(part))?String(part):'field').join('.')))];
    throw new ApiError(400, 'invalid_batch',fields);
  }
  const batch = parsed.data;
  for (const op of batch.operations) {
    if (op.op !== 'upsert') continue;
    const r = op.record;
    if (r.recordType !== batch.recordType) throw new ApiError(400, 'type_mismatch');
    if (Buffer.byteLength(JSON.stringify(r)) > 1024 * 1024) throw new ApiError(413, 'record_too_large');
    const [lo, hi] = bounds(r);
    ns(r.metadata.lastModifiedTime);
    // HC permits zero-duration sample records and samples at the record's end.
    if ('startTime' in r && lo > hi) throw new ApiError(400, 'invalid_time_boundary');
    if ('samples' in r) for (const s of r.samples) {
      if (ns(s.time) < lo || ns(s.time) > hi) throw new ApiError(400, 'sample_outside_record');
    }
    if ('stages' in r) for (const s of r.stages) assertSpan(s.startTime, s.endTime, lo, hi);
    if ('segments' in r) {
      for (const s of r.segments) assertSpan(s.startTime, s.endTime, lo, hi);
      for (const s of r.laps) assertSpan(s.startTime, s.endTime, lo, hi);
    }
  }
  return batch;
}
function canonical(value: unknown): string {
  if (Array.isArray(value)) return '[' + value.map(canonical).join(',') + ']';
  if (value !== null && typeof value === 'object') return '{' + Object.entries(value).sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => JSON.stringify(k) + ':' + canonical(v)).join(',') + '}';
  return JSON.stringify(value);
}
export const hash = (value: string | Uint8Array) => createHash('sha256').update(value).digest('hex');
export const contentHash = (value: unknown) => hash(canonical(value));
export const batchHash = (batch: Batch) => contentHash(batch);

export type Query = { start: string; end: string; type: string; origin: string | null; limit: number; after: string; fingerprint: string;
  /** Server-owned authorization bounds. Never populated from query parameters. */
  readWindow?: { start: string; end: string } };
export function parseQuery(url: URL): Query {
  const p = url.searchParams;
  const start = p.get('start') ?? '', end = p.get('end') ?? '', type = typeSchema.safeParse(p.get('type'));
  if (!type.success || ns(start) >= ns(end) || ns(end) - ns(start) > 366n * 86400n * 1000000000n) throw new ApiError(400, 'invalid_range');
  const origin = p.get('origin') ?? HEALTH_SYNC_ORIGIN;
  if (origin !== null && (origin.length === 0 || origin.length > 512)) throw new ApiError(400, 'invalid_origin');
  const limit = Number(p.get('limit') ?? 50);
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new ApiError(400, 'invalid_limit');
  const fingerprint = hash(JSON.stringify([ns(start).toString(), ns(end).toString(), type.data, origin]));
  let after = '0';
  if (p.has('cursor')) {
    try {
      const c = JSON.parse(Buffer.from(p.get('cursor')!, 'base64url').toString());
      if (c.f !== fingerprint || !/^\d{1,18}$/.test(c.a)) throw new Error();
      after = c.a;
    } catch { throw new ApiError(400, 'invalid_cursor'); }
  }
  return { start, end, type: type.data, origin, limit, after, fingerprint };
}
export const cursor = (q: Query, after: string) => Buffer.from(JSON.stringify({ f: q.fingerprint, a: after })).toString('base64url');
