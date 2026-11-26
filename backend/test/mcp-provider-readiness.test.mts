import { test } from 'node:test';
import assert from 'node:assert/strict';
import { inspectOAuthMetadata, oauthDiscoveryUrl, probeOAuthProvider } from '../mcp-provider-readiness.mts';

const issuer = 'https://identity.invalid/auth/v1';
const metadata = { issuer, authorization_endpoint: issuer + '/authorize', token_endpoint: issuer + '/token',
  jwks_uri: issuer + '/jwks', response_types_supported: ['code'], grant_types_supported: ['authorization_code', 'refresh_token'],
  code_challenge_methods_supported: ['S256'], scopes_supported: ['health:read'], token_endpoint_auth_methods_supported: ['none'] };
const reply = (body: unknown) => Response.json(body);

test('complete discovery is only metadata compatibility, never proof of live OAuth', () => {
  const result = inspectOAuthMetadata(issuer, metadata);
  assert.equal(result.metadataCompatible, true); assert.equal(result.endToEndReady, false);
  assert.equal(result.requiresClientRegistration, true); assert(result.unverified.includes('resource_audience'));
});
test('standard OIDC scopes cannot substitute for explicit health permission', () => {
  const result = inspectOAuthMetadata(issuer, { ...metadata, scopes_supported: ['openid', 'email', 'profile', 'phone'] });
  assert.equal(result.checks.healthReadScope, false); assert.equal(result.metadataCompatible, false);
});
test('missing advertised capabilities remain unknown rather than assumed supported', () => {
  const result = inspectOAuthMetadata(issuer, { issuer, authorization_endpoint: metadata.authorization_endpoint,
    token_endpoint: metadata.token_endpoint, jwks_uri: metadata.jwks_uri });
  assert.equal(result.checks.pkceS256, null); assert.equal(result.checks.healthReadScope, null);
  assert.equal(result.metadataCompatible, false);
});
test('wrong issuer, insecure endpoints and JWKS outside current verifier policy are rejected', () => {
  for (const change of [{ issuer: 'https://wrong.invalid' }, { authorization_endpoint: 'http://identity.invalid' },
    { token_endpoint: 'https://user:password@identity.invalid/token' }, { jwks_uri: 'https://other.invalid/jwks' },
    { code_challenge_methods_supported: ['plain'] }, { scopes_supported: 'health:read' },
    { token_endpoint_auth_methods_supported: ['unsupported'] }, { grant_types_supported: ['client_credentials'] }]) {
    assert.equal(inspectOAuthMetadata(issuer, { ...metadata, ...change }).metadataCompatible, false);
  }
});
test('public probe uses RFC8414 issuer-path discovery, no authentication and no redirects', async () => {
  assert.equal(oauthDiscoveryUrl(issuer), 'https://identity.invalid/.well-known/oauth-authorization-server/auth/v1');
  assert.equal(oauthDiscoveryUrl('https://identity.invalid'), 'https://identity.invalid/.well-known/oauth-authorization-server');
  const result = await probeOAuthProvider(issuer, async (url, options) => {
    assert.equal(url, oauthDiscoveryUrl(issuer)); assert.equal(options?.redirect, 'manual');
    assert.deepEqual(options?.headers, { Accept: 'application/json' }); assert(options.signal);
    return reply({ ...metadata, ignored_private_value: 'synthetic-canary-not-output' });
  });
  assert.equal(result.ok, true); assert(!JSON.stringify(result).includes('synthetic-canary-not-output'));
});
test('invalid or credential-bearing issuers never make a network request or echo the input', async () => {
  for (const value of ['http://identity.invalid', 'https://synthetic-user:synthetic-secret@identity.invalid',
    'https://identity.invalid?token=synthetic-secret', 'https://identity.invalid/#synthetic-secret', 'not a URL']) {
    const result = await probeOAuthProvider(value, async () => { throw new Error('Must not fetch'); });
    assert.deepEqual(result, { ok: false, error: 'invalid_issuer' }); assert(!JSON.stringify(result).includes('synthetic-secret'));
  }
});
test('redirects, network failures, non-JSON and malformed responses emit only fixed errors', async () => {
  const failures = [new Response('synthetic-private-error', { status: 302, headers: { Location: 'https://other.invalid' } }),
    new Response('synthetic-private-error'), Response.json(['synthetic-private-error']),
    new Response('{synthetic-private-error', { headers: { 'Content-Type': 'application/json' } })];
  for (const response of failures) {
    const result = await probeOAuthProvider(issuer, async () => response);
    assert.equal(result.ok, false); assert(!JSON.stringify(result).includes('synthetic-private-error'));
  }
  assert.deepEqual(await probeOAuthProvider(issuer, async () => { throw new Error('synthetic-private-error'); }),
    { ok: false, error: 'discovery_unavailable' });
});
test('oversized discovery is bounded by actual bytes even without Content-Length', async () => {
  let cancelled = false;
  const stream = new ReadableStream<Uint8Array>({ start(c) { c.enqueue(new Uint8Array(65_537)); }, cancel() { cancelled = true; } });
  const response = new Response(stream, { headers: { 'Content-Type': 'application/json' } });
  assert.deepEqual(await probeOAuthProvider(issuer, async () => response), { ok: false, error: 'discovery_too_large' });
  assert.equal(cancelled, true);
});
