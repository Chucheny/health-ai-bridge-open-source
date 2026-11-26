// Shared local Bridge configuration and bounded HTTPS transport. No I/O on import.
import { z } from 'zod';
import { TYPES } from './protocol.mts';

const configSchema = z.strictObject({ schemaVersion: z.literal(1), baseUrl: z.url(), ownerId: z.uuid(),
  sourceId: z.uuid(), token: z.string().regex(/^[A-Za-z0-9_-]{43}$/), allowedTypes: z.array(z.enum(TYPES)).min(1).max(15) });
export type BridgeClientConfig = z.infer<typeof configSchema>;
type Fetch = typeof globalThis.fetch;

export function parseBridgeClientConfig(input: unknown, requiredType: typeof TYPES[number]): BridgeClientConfig {
  try {
    const c = configSchema.parse(input), u = new URL(c.baseUrl);
    if (u.protocol !== 'https:' || u.username || u.password || u.search || u.hash || u.pathname !== '/' ||
        !c.allowedTypes.includes(requiredType)) throw new Error();
    return { ...c, baseUrl: u.origin };
  } catch { throw new Error('invalid_bridge_client_config'); }
}
export async function bridgeJson(config: BridgeClientConfig, path: string, init: RequestInit, fetcher: Fetch) {
  let response: Response | undefined;
  try {
    response = await fetcher(new URL(path, config.baseUrl), { ...init, redirect: 'error', credentials: 'omit',
      cache: 'no-store', referrerPolicy: 'no-referrer', signal: AbortSignal.timeout(30000),
      headers: { authorization: 'Bearer ' + config.token, 'content-type': 'application/json', accept: 'application/json' } });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error([400, 401, 403, 404, 409, 413, 415, 429].includes(response.status)
        ? 'bridge_rejected_' + response.status : 'bridge_outcome_unknown');
    }
    if (response.headers.get('content-type')?.split(';')[0].trim() !== 'application/json') throw new Error();
    const reader = response.body?.getReader(); if (!reader) throw new Error();
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > 65536) { await reader.cancel(); throw new Error(); }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch (error) {
    try { if (!response?.bodyUsed) await response?.body?.cancel(); } catch {}
    const message = error instanceof Error ? error.message : '';
    if (/^bridge_rejected_(400|401|403|404|409|413|415|429)$/.test(message)) throw new Error(message);
    throw new Error('bridge_outcome_unknown');
  }
}
