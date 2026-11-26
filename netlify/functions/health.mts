import type { Config, Context } from '@netlify/functions';
import { createHandler, reply } from '../../backend/api.mts';
import { postgresDatabase } from '../../backend/database.mts';

declare const Netlify: { env: { get(name: string): string | undefined } };
let handler: ReturnType<typeof createHandler> | undefined;
export default async (req: Request, context: Context) => {
  // Never attach the production health database to previews or branch deploys.
  if (context.deploy.context !== 'production' || !context.deploy.published || Netlify.env.get('HEALTH_API_ENABLED') !== 'true') {
    return reply({ error: 'service_not_configured' }, 503);
  }
  try {
    if (!handler) {
      const url = Netlify.env.get('HEALTH_DATABASE_URL');
      if (!url) return reply({ error: 'service_not_configured' }, 503);
      const reported=new Set<string>();
      handler = createHandler(postgresDatabase(url, Netlify.env.get('HEALTH_DATABASE_CA')),fields=>{
        const key=fields.join(',');
        if(!reported.has(key)){
          reported.add(key);
          console.warn(JSON.stringify({event:'schema_rejected',fields}));
        }
      }, { trainingCampEnabled: Netlify.env.get('HEALTH_TRAININGCAMP_ENABLED') === 'true' });
    }
    return await handler(req);
  } catch { return reply({ error: 'temporarily_unavailable' }, 503); }
};
export const config: Config = { path: ['/api/health/sync', '/api/health/sync/receipt', '/api/health/status', '/api/health/records',
  '/api/health/summary', '/api/health/revoke', '/api/health/data', '/api/health/trainingcamp/import',
  '/api/health/trainingcamp/sleep/import', '/api/health/trainingcamp/sleep/snapshots'] };
