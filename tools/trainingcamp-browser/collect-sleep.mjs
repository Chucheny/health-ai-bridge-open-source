// Serialized by chrome.scripting.executeScript into the active Huawei page.
// Keep self-contained: credentials never leave this function, return values or fixed error codes only.
export async function collectTrainingCampInPage(request) {
  const error = code => ({ ok: false, code });
  const origin = 'https://health.cloud.huawei.com';
  const apiOrigin = 'https://hihealthbase-drcn.things.dbankcloud.cn';
  const limit = 8 * 1024 * 1024;
  let timer, controller;
  try {
    if (location.origin !== origin || location.pathname !== '/TrainingCamp') return error('wrong_page');
    const kind = request?.kind ?? 'sleep'; // Preserve the previous sleep-only serialized caller.
    if (kind !== 'sleep' && kind !== 'activity') return error('invalid_kind');
    const activity = kind === 'activity';
    const scroll = request?.scroll === true;
    if (scroll && !activity) return error('invalid_kind');
    const day = text => {
      if (typeof text !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(text)) throw new Error();
      const midnight = Date.parse(text + 'T00:00:00Z');
      if (!Number.isFinite(midnight) || new Date(midnight).toISOString().slice(0, 10) !== text) throw new Error();
      return midnight - 8 * 60 * 60 * 1000;
    };
    let start, end;
    try {
      start = day(request?.startDay); end = day(request?.endDay) + 86400000;
      if (start >= end || end - start > 31 * 86400000) throw new Error();
    } catch { return error('invalid_dates'); }
    // Frontend's documented-in-source storage/config keys; no cookies or complete config export.
    const token = sessionStorage.getItem('accessToken');
    const expires = Number(sessionStorage.getItem('expireTime'));
    if (!token || !/^[^\s]{1,8192}$/.test(token) || !Number.isFinite(expires) || expires <= Date.now()) {
      return error('login_required');
    }
    const clientId = window.SYS_GLOBAL_CONFIG?.login?.viteClientId;
    const version = window.MAIN_CONFIG?.appVersion;
    if (typeof clientId !== 'string' || !/^[A-Za-z0-9_-]{1,128}$/.test(clientId) ||
        typeof version !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(version)) return error('page_changed');
    const lo = BigInt(start) * 1000000n, hi = BigInt(end) * 1000000n;
    const pageSize = 20;
    const maxPages = scroll ? 5 : 1;
    const apiRequest = activity ? { startTimeMs: String(start), endTimeMs: String(end - 1), limit: pageSize, order: 'endTimeDesc' }
      : { startTimeNs: String(lo), endTimeNs: String(hi - 1n) };
    const url = new URL(activity ? '/healthrunninggroup/v1/activityRecord:query' : '/healthrunninggroup/v1/healthRecords', apiOrigin);
    if (!activity) url.search = new URLSearchParams({ startTime: String(lo), endTime: String(hi - 1n),
      dataType: 'com.huawei.health.record.sleep', subDataType: 'com.huawei.continuous.sleep.fragment' }).toString();
    controller = new AbortController(); timer = setTimeout(() => controller.abort(), 30000);
    const seen = new Set();
    const pages = [];
    let totalBytes = 0, sourceRecords = 0, previousFinish, pageEnd = BigInt(end - 1);
    const readPage = async pageEnd => {
      let response;
      try {
        response = await fetch(url.href, { method: activity ? 'POST' : 'GET', mode: 'cors', credentials: 'omit', redirect: 'error',
          cache: 'no-store', referrerPolicy: 'no-referrer', signal: controller.signal,
          ...(activity ? { body: JSON.stringify({ startTime: apiRequest.startTimeMs, endTime: String(pageEnd),
            limit: pageSize, filterList: [], order: 'endTimeDesc' }) } : {}),
          headers: { Accept: 'application/json', Authorization: 'Bearer ' + token,
            'x-client-id': clientId, 'x-version': version, ...(activity ? { 'Content-Type': 'application/json' } : {}) } });
      } catch { return error('request_failed'); }
      if (response.status === 401 || response.status === 403) return error('login_or_permission_required');
      if (response.status === 429) return error('rate_limited');
      if (!response.ok) return error('http_error');
      if (new URL(response.url).origin !== apiOrigin ||
          !/^application\/json(?:;|$)/i.test(response.headers.get('content-type') || '')) return error('unexpected_response');
      const reader = response.body?.getReader();
      if (!reader) return error('unexpected_response');
      const chunks = []; let size = 0;
      try {
        for (;;) {
          const { done, value } = await reader.read(); if (done) break;
          size += value.byteLength;
          if (totalBytes + size > limit) { await reader.cancel(); return error('response_too_large'); }
          chunks.push(value);
        }
      } finally { reader.releaseLock(); }
      const bytes = new Uint8Array(size); let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      const raw = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      if (raw.includes(token)) return error('unexpected_response');
      // Preserve unsafe integer digits for validation; export the untouched response text.
      let parsed;
      try {
        parsed = JSON.parse(raw, (key, value, context) => {
          if (typeof value !== 'number') return value;
          if (!Number.isFinite(value)) throw new Error();
          if (['startTime', 'endTime', 'longValue', 'integerValue'].includes(key) &&
              context?.source && !/^-?\d+$/.test(context.source)) throw new Error();
          if (Math.abs(value) > Number.MAX_SAFE_INTEGER) {
            if (!context?.source || !/^-?\d+$/.test(context.source)) throw new Error();
            return context.source;
          }
          return value;
        });
        if (JSON.stringify(parsed).includes(token)) throw new Error();
        if (activity) {
          if (!Array.isArray(parsed) || parsed.length > pageSize) throw new Error();
        } else if (!parsed || Array.isArray(parsed) || Object.keys(parsed).some(key => key !== 'healthRecords') ||
            !Array.isArray(parsed.healthRecords) || parsed.healthRecords.length > 1000) throw new Error();
      } catch { return error('unexpected_response'); }
      const integer = value => {
        if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error();
        if (!['string', 'number'].includes(typeof value) || !/^\d{1,30}$/.test(String(value))) throw new Error();
        return BigInt(value);
      };
      let lastStart;
      try {
        if (activity) {
          const milliseconds = value => { const n = integer(value); if (n > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(); return n; };
          for (const record of parsed) {
            if (!record || typeof record !== 'object' || typeof record.id !== 'string' || record.id.length < 1 || record.id.length > 256 || seen.has(record.id)) throw new Error();
            seen.add(record.id);
            const a = milliseconds(record.startTime), b = milliseconds(record.endTime);
            milliseconds(record.modifyTime);
            if (a < BigInt(start) || b > BigInt(end) || a >= b || (scroll && a > pageEnd)) throw new Error();
            if (scroll && previousFinish !== undefined && b > previousFinish) return error('activity_scroll_stalled');
            previousFinish = b;
            lastStart = a;
            if (typeof record.activityType === 'number') { if (!Number.isSafeInteger(record.activityType) || record.activityType < 0) throw new Error(); }
            else if (typeof record.activityType !== 'string' || record.activityType.length < 1 || record.activityType.length > 64) throw new Error();
            if (record.timeZone !== undefined && record.timeZone !== null && (typeof record.timeZone !== 'string' || record.timeZone.length > 64)) throw new Error();
            if (record.activeTime !== undefined) integer(record.activeTime);
            if (record.activitySummary !== undefined && (!record.activitySummary || typeof record.activitySummary !== 'object' || Array.isArray(record.activitySummary))) throw new Error();
          }
        } else for (const record of parsed.healthRecords) {
          if (record.dataType !== undefined && record.dataType !== 'com.huawei.health.record.sleep') throw new Error();
          if (record.dataTypeName !== undefined && record.dataTypeName !== 'com.huawei.health.record.sleep') throw new Error();
          if (record.subData && Object.keys(record.subData).some(key => key !== 'com.huawei.continuous.sleep.fragment')) throw new Error();
          const a = integer(record.startTime), b = integer(record.endTime);
          if (a < lo || b > hi || a >= b || !Array.isArray(record.value) || record.value.length > 128) throw new Error();
          for (const field of record.value) {
            if (['go_bed_time', 'fall_asleep_time', 'wakeup_time'].includes(field.fieldName)) {
              const time = integer(field.longValue) * 1000000n;
              if (time < lo || time >= hi) throw new Error();
            }
          }
          const stages = record.subData?.['com.huawei.continuous.sleep.fragment']?.samplePoints;
          if (stages !== undefined) {
            if (!Array.isArray(stages) || stages.length > 20000) throw new Error();
            for (const stage of stages) {
              if (stage.dataType !== undefined && stage.dataType !== 'com.huawei.continuous.sleep.fragment') throw new Error();
              if (stage.dataTypeName !== undefined && stage.dataTypeName !== 'com.huawei.continuous.sleep.fragment') throw new Error();
              const c = integer(stage.startTime), d = integer(stage.endTime);
              if (c < a || d > b || c >= d) throw new Error();
            }
          }
        }
      } catch { return error('response_outside_window_or_invalid'); }
      return { ok: true, raw, size, lastStart, count: activity ? parsed.length : parsed.healthRecords.length };
    };
    for (let index = 0; index < maxPages; index++) {
      const page = await readPage(pageEnd);
      if (!page.ok) return page;
      totalBytes += page.size;
      sourceRecords += page.count;
      pages.push({ endTimeMs: String(pageEnd), rawResponse: page.raw });
      if (page.count < pageSize || index === maxPages - 1) break;
      // Huawei's activity page uses the last record's start time as the next request's end.
      if (page.lastStart <= BigInt(start)) break;
      if (page.lastStart >= pageEnd) return error('activity_scroll_stalled');
      pageEnd = page.lastStart;
    }
    return { ok: true, capture: { schemaVersion: 1, source: 'huawei_trainingcamp', kind,
      requestedWindow: { start: new Date(start).toISOString(), end: new Date(end).toISOString() },
      apiRequest, capturedAt: new Date().toISOString(), sourceCompleteness: 'unknown',
      ...(scroll ? { captureScope: 'bounded_scroll', pages } : {
        ...(activity ? { captureScope: 'first_response_only' } : {}), rawResponse: pages[0].rawResponse,
      }) }, sourceRecords };
  } catch { return error('collection_failed'); }
  finally { if (timer !== undefined) clearTimeout(timer); controller?.abort(); }
}

export { collectTrainingCampInPage as collectSleepInPage };
