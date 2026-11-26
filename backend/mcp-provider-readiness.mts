// Operator-only discovery inspection. Never consumes credentials or queries health data.
const MAX_METADATA_BYTES = 65_536;
function httpsUrl(value: unknown): URL {
  if (typeof value !== 'string' || value.length > 2048) throw new Error('invalid_metadata_url');
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.search || url.hash) throw new Error('invalid_metadata_url');
  return url;
}
export function oauthDiscoveryUrl(issuer: string): string {
  const url = httpsUrl(issuer);
  return `${url.origin}/.well-known/oauth-authorization-server${url.pathname === '/' ? '' : url.pathname}`;
}
function advertised(metadata: Record<string, unknown>, field: string, expected: string[]): boolean | null {
  if (metadata[field] === undefined) return null;
  const values = metadata[field];
  return Array.isArray(values) && values.length <= 128 && values.every(v => typeof v === 'string') &&
    expected.some(v => values.includes(v));
}
export function inspectOAuthMetadata(issuer: string, input: unknown) {
  const expected = httpsUrl(issuer);
  if (!input || typeof input !== 'object' || Array.isArray(input)) throw new Error('invalid_metadata');
  const metadata = input as Record<string, unknown>;
  const endpoint = (field: string) => { try { httpsUrl(metadata[field]); return true; } catch { return false; } };
  let sameOriginJwks = false;
  try { sameOriginJwks = httpsUrl(metadata.jwks_uri).origin === expected.origin; } catch { }
  const checks = {
    issuerMatches: metadata.issuer === issuer,
    httpsAuthorizationEndpoint: endpoint('authorization_endpoint'),
    httpsTokenEndpoint: endpoint('token_endpoint'), sameOriginJwks,
    codeResponse: advertised(metadata, 'response_types_supported', ['code']),
    authorizationCodeGrant: advertised(metadata, 'grant_types_supported', ['authorization_code']),
    pkceS256: advertised(metadata, 'code_challenge_methods_supported', ['S256']),
    healthReadScope: advertised(metadata, 'scopes_supported', ['health:read']),
    clientAuthentication: advertised(metadata, 'token_endpoint_auth_methods_supported',
      ['none', 'client_secret_basic', 'client_secret_post', 'private_key_jwt']),
  };
  return { checks, metadataCompatible: Object.values(checks).every(v => v === true),
    endToEndReady: false as const, requiresClientRegistration: true as const,
    unverified: ['signature', 'resource_audience', 'subject', 'client_id', 'granted_health_scope', 'expiry', 'revocation'] };
}
export async function probeOAuthProvider(issuer: string, fetcher: typeof fetch = fetch) {
  let url: string;
  try { url = oauthDiscoveryUrl(issuer); }
  catch { return { ok: false as const, error: 'invalid_issuer' }; }
  try {
    const response = await fetcher(url, { method: 'GET', redirect: 'manual',
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    if (response.status !== 200) {
      await response.body?.cancel();
      return { ok: false as const, error: 'discovery_http_error', httpStatus: response.status };
    }
    const type = response.headers.get('content-type')?.split(';')[0].trim();
    if (type !== 'application/json' && !type?.endsWith('+json')) {
      await response.body?.cancel();
      return { ok: false as const, error: 'discovery_not_json' };
    }
    if (Number(response.headers.get('content-length')) > MAX_METADATA_BYTES) {
      await response.body?.cancel();
      return { ok: false as const, error: 'discovery_too_large' };
    }
    const reader = response.body?.getReader();
    if (!reader) return { ok: false as const, error: 'discovery_invalid_metadata' };
    const chunks: Uint8Array[] = []; let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read(); if (done) break;
        size += value.byteLength;
        if (size > MAX_METADATA_BYTES) {
          await reader.cancel(); return { ok: false as const, error: 'discovery_too_large' };
        }
        chunks.push(value);
      }
    } finally { reader.releaseLock(); }
    let readiness: ReturnType<typeof inspectOAuthMetadata>;
    try { readiness = inspectOAuthMetadata(issuer, JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)))); }
    catch { return { ok: false as const, error: 'discovery_invalid_metadata' }; }
    return { ok: true as const, readiness };
  } catch { return { ok: false as const, error: 'discovery_unavailable' }; }
}
