import type { Config, Context } from '@netlify/functions';
import { postgresDatabase } from '../../backend/database.mts';
import { createMcpHandler } from '../../backend/mcp.mts';
import { oauthVerifier, parseMcpSettings } from '../../backend/mcp-auth.mts';

declare const Netlify: { env: { get(name: string): string | undefined } };
let handler: ReturnType<typeof createMcpHandler> | undefined;
export default async (request: Request, context: Context) => {
  // Independent switch; enabling phone sync does not authorize ChatGPT access.
  if (context.deploy.context !== 'production' || !context.deploy.published || Netlify.env.get('HEALTH_MCP_ENABLED') !== 'true') {
    return Response.json({ error: 'service_not_configured' }, { status: 503, headers: { 'Cache-Control': 'no-store, private' } });
  }
  try {
    if (!handler) {
      const raw = Netlify.env.get('HEALTH_MCP_CONFIG');
      const databaseUrl = Netlify.env.get('HEALTH_DATABASE_URL');
      if (!raw || !databaseUrl) throw new Error();
      const settings = parseMcpSettings({ ...JSON.parse(raw),
        trainingCampEnabled: Netlify.env.get('HEALTH_TRAININGCAMP_ENABLED') === 'true' });
      handler = createMcpHandler(postgresDatabase(databaseUrl, Netlify.env.get('HEALTH_DATABASE_CA')),
        settings, oauthVerifier(settings));
    }
    return await handler(request);
  } catch { return Response.json({ error: 'service_unavailable' }, { status: 503, headers: { 'Cache-Control': 'no-store, private' } }); }
};
export const config: Config = {
  path: ['/mcp', '/.well-known/oauth-protected-resource/mcp'],
  rateLimit: { windowSize: 60, windowLimit: 60, aggregateBy: ['ip', 'domain'] },
};
