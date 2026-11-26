import { createRemoteJWKSet, jwtVerify } from 'jose';
import type { JWTVerifyGetKey } from 'jose';
import { z } from 'zod';
import { ns, typeSchema } from './protocol.mts';

const httpsUrl = z.url().refine(value => {
  const u = new URL(value);
  return u.protocol === 'https:' && !u.username && !u.password && !u.search && !u.hash;
});
const settingsSchema = z.strictObject({
  resource: httpsUrl, issuer: httpsUrl, jwksUrl: httpsUrl,
  subject: z.string().min(1).max(200), clientId: z.string().min(1).max(512),
  ownerId: z.uuid(), types: z.array(typeSchema).min(1).max(15),
  trainingCampEnabled: z.boolean().optional(),
  readWindow: z.strictObject({
    start: z.iso.datetime({ offset: true }), end: z.iso.datetime({ offset: true }),
  }).refine(value => ns(value.start) < ns(value.end)).optional(),
});
export type McpSettings = z.infer<typeof settingsSchema>;
export function parseMcpSettings(input: unknown): McpSettings {
  try {
    const s = settingsSchema.parse(input);
    if (new URL(s.resource).pathname !== '/mcp' ||
        new URL(s.jwksUrl).origin !== new URL(s.issuer).origin ||
        new Set(s.types).size !== s.types.length) throw new Error();
    return s;
  } catch { throw new Error('Invalid MCP configuration'); }
}

/** An OAuth access token, never a phone token or a browser sign-in token. */
export function oauthVerifier(settings: McpSettings,
  key: JWTVerifyGetKey = createRemoteJWKSet(new URL(settings.jwksUrl))) {
  return async (token: string): Promise<boolean> => {
    try {
      const { payload } = await jwtVerify(token, key, {
        issuer: settings.issuer, audience: settings.resource, subject: settings.subject,
        algorithms: ['RS256', 'ES256'], requiredClaims: ['exp', 'iat', 'sub'],
        clockTolerance: 5,
      });
      return payload.client_id === settings.clientId &&
        typeof payload.scope === 'string' && payload.scope.split(' ').includes('health:read') &&
        typeof payload.iat === 'number' && payload.iat <= Date.now() / 1000 + 5 &&
        typeof payload.exp === 'number' && payload.exp > payload.iat && payload.exp - payload.iat <= 3600;
    } catch { return false; }
  };
}
