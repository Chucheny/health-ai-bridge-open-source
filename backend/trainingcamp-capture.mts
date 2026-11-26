// Offline boundary between browser capture files and the existing source adapter. No network or DB.
import { z } from 'zod';
import { contentHash, ns } from './protocol.mts';
import { inspectTrainingCampSleep, MAX_TRAININGCAMP_INPUT_BYTES, parseTrainingCampJson } from './trainingcamp-semantics.mts';
import { parseTrainingCampImport } from './trainingcamp-store.mts';

export const MAX_TRAININGCAMP_CAPTURE_BYTES = 2 * MAX_TRAININGCAMP_INPUT_BYTES + 65536;
export const MAX_TRAININGCAMP_ACTIVITY_CAPTURES = 31;
const windowSchema = z.strictObject({ start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }) });
const captureSchema = z.strictObject({
  schemaVersion: z.literal(1), source: z.literal('huawei_trainingcamp'), kind: z.literal('sleep'),
  requestedWindow: windowSchema,
  apiRequest: z.strictObject({ startTimeNs: z.string().regex(/^\d{1,30}$/), endTimeNs: z.string().regex(/^\d{1,30}$/) }),
  capturedAt: z.iso.datetime({ offset: true }), sourceCompleteness: z.literal('unknown'),
  rawResponse: z.string().max(MAX_TRAININGCAMP_INPUT_BYTES),
});

const activityCaptureFields = {
  schemaVersion: z.literal(1), source: z.literal('huawei_trainingcamp'), kind: z.literal('activity'),
  requestedWindow: windowSchema,
  apiRequest: z.strictObject({ startTimeMs: z.string().regex(/^\d{1,16}$/), endTimeMs: z.string().regex(/^\d{1,16}$/),
    limit: z.literal(20), order: z.literal('endTimeDesc') }),
  capturedAt: z.iso.datetime({ offset: true }), sourceCompleteness: z.literal('unknown'),
};
const activityScrollPageLimit = 5;
const activityRawResponseSchema = z.string().max(MAX_TRAININGCAMP_INPUT_BYTES);
const activityCaptureSchema = z.discriminatedUnion('captureScope', [
  z.strictObject({ ...activityCaptureFields, captureScope: z.literal('first_response_only'), rawResponse: activityRawResponseSchema }),
  z.strictObject({ ...activityCaptureFields, captureScope: z.literal('bounded_scroll'), pages: z.array(z.strictObject({
    endTimeMs: z.string().regex(/^\d{1,16}$/), rawResponse: activityRawResponseSchema,
  })).min(1).max(activityScrollPageLimit) }),
]);

function parseActivityCapture(input: unknown, authorizedWindow: unknown) {
  const capture = activityCaptureSchema.parse(input), authorization = windowSchema.parse(authorizedWindow);
  const lo = ns(capture.requestedWindow.start), hi = ns(capture.requestedWindow.end);
  if (lo >= hi || ns(authorization.start) >= ns(authorization.end) || lo < ns(authorization.start) || hi > ns(authorization.end) ||
      hi - lo > 31n * 86400n * 1000000000n || lo % 1000000n !== 0n || hi % 1000000n !== 0n ||
      BigInt(capture.apiRequest.startTimeMs) * 1000000n !== lo ||
      (BigInt(capture.apiRequest.endTimeMs) + 1n) * 1000000n !== hi) throw new Error();
  const pages = capture.captureScope === 'bounded_scroll' ? capture.pages
    : [{ endTimeMs: capture.apiRequest.endTimeMs, rawResponse: capture.rawResponse }];
  let bytes = 0;
  const recordsByPage = pages.map(({ rawResponse }) => {
    bytes += Buffer.byteLength(rawResponse);
    if (bytes > MAX_TRAININGCAMP_INPUT_BYTES) throw new Error();
    const records = parseTrainingCampJson(rawResponse);
    if (!Array.isArray(records) || records.length > capture.apiRequest.limit) throw new Error();
    return records;
  });
  const records = recordsByPage.flat();
  // Reuse the original import invariants; this validator-only batch ID is never persisted or uploaded.
  const normalized = parseTrainingCampImport({ schemaVersion: 1, batchId: '00000000-0000-4000-8000-000000000001',
    source: 'huawei_trainingcamp', requestedWindow: capture.requestedWindow, records }).records;
  if (capture.captureScope === 'bounded_scroll') {
    let offset = 0, expectedEnd = BigInt(capture.apiRequest.endTimeMs);
    let previousFinish: bigint | undefined;
    for (const [index, page] of pages.entries()) {
      if (BigInt(page.endTimeMs) !== expectedEnd) throw new Error();
      const count = recordsByPage[index].length;
      for (const record of normalized.slice(offset, offset + count)) {
        const finish = BigInt(record.endTimeMs);
        if (BigInt(record.startTimeMs) > expectedEnd || (previousFinish !== undefined && finish > previousFinish)) throw new Error();
        previousFinish = finish;
      }
      offset += count;
      const lastStart = count === 0 ? 0n : BigInt(normalized[offset - 1].startTimeMs);
      const mustContinue = count === capture.apiRequest.limit && lastStart > lo / 1000000n &&
        index < activityScrollPageLimit - 1;
      if (mustContinue !== (index + 1 < pages.length) || (mustContinue && lastStart >= expectedEnd)) throw new Error();
      expectedEnd = lastStart;
    }
  }
  return { capture, records, normalized, lo, hi };
}

/** Validates observed responses; Training Camp source coverage stays unknown. */
export function verifyTrainingCampActivityCapture(input: unknown, authorizedWindow: unknown) {
  try {
    const { capture, records } = parseActivityCapture(input, authorizedWindow);
    return { records, requestedWindow: capture.requestedWindow, sourceCollectedAt: capture.capturedAt,
      counts: { sourceRecords: records.length }, sourceCompleteness: capture.sourceCompleteness, captureScope: capture.captureScope,
      captureValidation: { authorizedWindowEnforced: true, sourceRecordsValidated: true }, liveReadingVerified: false as const };
  } catch { throw new Error('invalid_trainingcamp_activity_capture'); }
}

const activityCaptureSetSchema = z.strictObject({ captures: z.array(z.unknown()).min(2).max(MAX_TRAININGCAMP_ACTIVITY_CAPTURES) });

export function combineTrainingCampActivityCaptures(input: unknown, authorizedWindow: unknown) {
  const parts = activityCaptureSetSchema.parse(input).captures.map(part => parseActivityCapture(part, authorizedWindow));
  if (parts.some(part => part.capture.captureScope !== 'first_response_only')) throw new Error();
  parts.sort((a, b) => a.lo < b.lo ? -1 : a.lo > b.lo ? 1 : 0);
  const requestedWindow = { ...parts[0].capture.requestedWindow };
  let end = parts[0].hi;
  const byId = new Map<string, { hash: string; record: unknown }>();
  for (const part of parts) {
    // A single task queries one range. Do not include an unselected gap between captures.
    if (part.lo > end) throw new Error();
    if (part.hi > end) {
      end = part.hi;
      requestedWindow.end = part.capture.requestedWindow.end;
    }
    for (const [index, record] of part.normalized.entries()) {
      const hash = contentHash(record), prior = byId.get(record.sourceRecordId);
      if (prior && prior.hash !== hash) throw new Error();
      if (!prior) byId.set(record.sourceRecordId, { hash, record: part.records[index] });
    }
  }
  return { requestedWindow, records: [...byId.values()].map(entry => entry.record) };
}

/** Caller supplies authorization independently of the capture file; metadata is never proof of live access. */
export function verifyTrainingCampSleepCapture(input: unknown, authorizedWindow: unknown) {
  try {
    const capture = captureSchema.parse(input), authorization = windowSchema.parse(authorizedWindow);
    const lo = ns(capture.requestedWindow.start), hi = ns(capture.requestedWindow.end);
    const authorizedLo = ns(authorization.start), authorizedHi = ns(authorization.end);
    if (authorizedLo >= authorizedHi || lo >= hi || lo < authorizedLo || hi > authorizedHi ||
        hi - lo > 31n * 86400n * 1000000000n || BigInt(capture.apiRequest.startTimeNs) !== lo ||
        BigInt(capture.apiRequest.endTimeNs) !== hi - 1n) throw new Error();
    const raw = parseTrainingCampJson(capture.rawResponse) as { healthRecords?: unknown[] };
    if (!raw || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'healthRecords')) throw new Error();
    const result = inspectTrainingCampSleep(raw);
    for (const record of raw.healthRecords ?? []) {
      const r = record as { dataType?: unknown; subData?: object };
      if (r.dataType !== undefined && r.dataType !== 'com.huawei.health.record.sleep') throw new Error();
      if (r.subData && Object.keys(r.subData).some(key => key !== 'com.huawei.continuous.sleep.fragment')) throw new Error();
    }
    for (const record of result.records) {
      if (record.rawStartTime === null || record.rawEndTime === null) throw new Error();
      const a = BigInt(record.rawStartTime), b = BigInt(record.rawEndTime);
      if (a < lo || b > hi || a >= b) throw new Error();
      for (const field of record.fields) {
        if (['go_bed_time', 'fall_asleep_time', 'wakeup_time'].includes(field.fieldName)) {
          if (field.longValue === undefined) throw new Error();
          const time = BigInt(field.longValue) * 1000000n;
          if (time < lo || time >= hi) throw new Error();
        }
      }
      for (const stage of record.stages) {
        if (BigInt(stage.startTimeNs) < a || BigInt(stage.endTimeNs) > b) throw new Error();
      }
    }
    return { ...result, requestedWindow: capture.requestedWindow, sourceCollectedAt: capture.capturedAt,
      captureValidation: { authorizedWindowEnforced: true, sourceSessionsValidated: true },
      liveReadingVerified: false as const };
  } catch { throw new Error('invalid_trainingcamp_capture'); }
}
