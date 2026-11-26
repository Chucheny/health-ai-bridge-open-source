import { ApiError, parseBatch, parseQuery } from './protocol.mts';
import { authenticate, records, requireScope, summary, sync } from './database.mts';
import type { Database } from './database.mts';
import { parseTrainingCampJson } from './trainingcamp-semantics.mts';
import { WEB_IMPORT_ROUTES } from './bridge-sources.mts';
import { importTrainingCampActivities, parseTrainingCampImport, parseTrainingCampQuery,
  TRAININGCAMP_SOURCE, trainingCampRecords, trainingCampSummary } from './trainingcamp-store.mts';
import { importTrainingCampSleep, parseTrainingCampSleepImport, trainingCampSleepRecords,
  trainingCampSleepSummary, trainingCampSleepSnapshots } from './trainingcamp-sleep-store.mts';

export const reply = (body: unknown, status = 200) => Response.json(body, { status, headers: {
  'Cache-Control': 'no-store, private', 'Pragma': 'no-cache', 'X-Content-Type-Options': 'nosniff',
  'Strict-Transport-Security': 'max-age=31536000',
} });
async function jsonBody(req: Request, lossless = false): Promise<unknown> {
  if (req.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new ApiError(415, 'json_required');
  if (req.headers.has('content-encoding')) throw new ApiError(415, 'encoding_not_supported');
  const max = 2 * 1024 * 1024;
  if (Number(req.headers.get('content-length') ?? 0) > max) throw new ApiError(413, 'batch_too_large');
  const reader = req.body?.getReader();
  if (!reader) throw new ApiError(400, 'invalid_json');
  const chunks: Uint8Array[] = []; let length = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.byteLength;
      if (length > max) { await reader.cancel(); throw new ApiError(413, 'batch_too_large'); }
      chunks.push(value);
    }
  } finally { reader.releaseLock(); }
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks));
    return lossless ? parseTrainingCampJson(text) : JSON.parse(text);
  }
  catch { throw new ApiError(400, 'invalid_json'); }
}
export function createHandler(db: Database, onSchemaRejected?: (fields: string[]) => void,
  options: { trainingCampEnabled?: boolean } = {}) {
  return async (req: Request): Promise<Response> => {
    try {
      const url = new URL(req.url), path = url.pathname;
      if (url.protocol !== 'https:') throw new ApiError(400, 'https_required');
      if (url.username || url.password || url.searchParams.has('token') || url.searchParams.has('access_token')) throw new ApiError(400, 'invalid_url');
      const routes: Record<string, string> = {
        '/api/health/sync': 'POST', '/api/health/status': 'GET', '/api/health/records': 'GET',
        '/api/health/summary': 'GET', '/api/health/revoke': 'POST', '/api/health/data': 'DELETE',
      };
      if (options.trainingCampEnabled) {
        routes[WEB_IMPORT_ROUTES.activity] = 'POST';
        routes[WEB_IMPORT_ROUTES.sleep] = 'POST';
        routes['/api/health/trainingcamp/sleep/snapshots'] = 'GET';
      }
      if (!(path in routes)) throw new ApiError(404, 'not_found');
      if (req.method !== routes[path]) throw new ApiError(405, 'method_not_allowed');
      // Read a bounded body before opening a transaction (avoids slow-client DB locks).
      const importing = path === WEB_IMPORT_ROUTES.activity || path === WEB_IMPORT_ROUTES.sleep;
      const input = path.endsWith('/sync') || importing ? await jsonBody(req, importing) : undefined;
      const source = url.searchParams.get('source') ?? 'health_sync';
      if (path.endsWith('/records') || path.endsWith('/summary')) {
        if (!['health_sync', TRAININGCAMP_SOURCE].includes(source)) throw new ApiError(400, 'invalid_source');
        if (source === TRAININGCAMP_SOURCE && !options.trainingCampEnabled) throw new ApiError(403, 'source_not_enabled');
        if (source !== TRAININGCAMP_SOURCE && url.searchParams.has('snapshot')) throw new ApiError(400, 'snapshot_not_supported');
        if (source !== TRAININGCAMP_SOURCE && url.searchParams.has('sleepStages')) throw new ApiError(400, 'sleep_stage_paging_not_supported');
      }
      const body = await db.transaction(async sql => {
        const p = await authenticate(sql, req.headers.get('authorization'));
        switch (path) {
          case '/api/health/sync': return sync(sql, p, parseBatch(input));
          case WEB_IMPORT_ROUTES.activity: return importTrainingCampActivities(sql, p, parseTrainingCampImport(input));
          case WEB_IMPORT_ROUTES.sleep: return importTrainingCampSleep(sql, p, parseTrainingCampSleepImport(input));
          case '/api/health/trainingcamp/sleep/snapshots': return trainingCampSleepSnapshots(sql, p, url);
          case '/api/health/status':
            requireScope(p, 'read');
            return { streams: (await sql.query(`SELECT record_type,sequence::text,committed_at FROM health_bridge.sync_streams
              WHERE owner_id=$1 AND source_id=$2 AND record_type=ANY($3::text[]) ORDER BY record_type`, [p.owner, p.source, p.types])).rows };
          case '/api/health/records': {
            if (source !== TRAININGCAMP_SOURCE) return records(sql, p, parseQuery(url));
            const q = parseTrainingCampQuery(url);
            return q.type === 'SleepSessionRecord' ? trainingCampSleepRecords(sql, p, q) : trainingCampRecords(sql, p, q);
          }
          case '/api/health/summary': {
            if (source !== TRAININGCAMP_SOURCE) return summary(sql, p, parseQuery(url));
            const q = parseTrainingCampQuery(url);
            return q.type === 'SleepSessionRecord' ? trainingCampSleepSummary(sql, p, q) : trainingCampSummary(sql, p, q);
          }
          case '/api/health/revoke':
            requireScope(p, 'revoke');
            await sql.query('UPDATE health_bridge.device_tokens SET revoked_at=now() WHERE token_hash=$1', [p.tokenHash]);
            return { revoked: true };
          case '/api/health/data':
            requireScope(p, 'clear');
            if (req.headers.get('x-confirm-clear') !== 'delete-all-my-cloud-health-data') throw new ApiError(400, 'confirmation_required');
            await sql.query('DELETE FROM health_bridge.health_records WHERE owner_id=$1', [p.owner]);
            // Clear all retained sources even after the new source's feature switch is turned off.
            if ((await sql.query("SELECT to_regclass('health_bridge.trainingcamp_activities') AS relation")).rows[0]?.relation) {
              await sql.query('DELETE FROM health_bridge.trainingcamp_activities WHERE owner_id=$1', [p.owner]);
            }
            if ((await sql.query("SELECT to_regclass('health_bridge.trainingcamp_sleep_snapshots') AS relation")).rows[0]?.relation) {
              await sql.query('DELETE FROM health_bridge.trainingcamp_sleep_snapshots WHERE owner_id=$1', [p.owner]);
            }
            await sql.query('DELETE FROM health_bridge.sync_batches WHERE owner_id=$1', [p.owner]);
            await sql.query('DELETE FROM health_bridge.sync_streams WHERE owner_id=$1', [p.owner]);
            await sql.query('UPDATE health_bridge.device_tokens SET revoked_at=now() WHERE owner_id=$1', [p.owner]);
            return { cleared: true, allCredentialsRevoked: true };
        }
      });
      return reply(body);
    } catch (error) {
      // Do not expose validation input, pg details, token, URL or health values.
      if(error instanceof ApiError && error.validationFields){
        // Whitelisted static field names only, never request input or a raw error.
        try{onSchemaRejected?.(error.validationFields);}catch{}
      }
      return error instanceof ApiError ? reply({ error: error.code,
        ...(error.validationFields?{validationFields:error.validationFields}:{}) }, error.status) : reply({ error: 'temporarily_unavailable' }, 503);
    }
  };
}
