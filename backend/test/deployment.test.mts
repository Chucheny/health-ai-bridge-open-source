import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from '@netlify/functions';
import health, { config } from '../../netlify/functions/health.mts';
import { WEB_IMPORT_ROUTES } from '../bridge-sources.mts';

test('Netlify declares receipt recovery and all Training Camp routes accepted by the health handler', () => {
  assert(Array.isArray(config.path));
  for (const path of ['/api/health/sync/receipt', ...Object.values(WEB_IMPORT_ROUTES), '/api/health/trainingcamp/sleep/snapshots'] as const) {
    assert(config.path.includes(path), `Missing Netlify route: ${path}`);
  }
});

test('Netlify preview, unpublished and unconfigured deploys fail closed without database access', async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, 'Netlify');
  try {
    const values: Record<string, string> = { HEALTH_API_ENABLED: 'true' };
    Object.defineProperty(globalThis, 'Netlify', { configurable: true, value: { env: { get: (k: string) => values[k] } } });
    const req = () => new Request('https://private.invalid/api/health/status');
    for (const [context, published] of [['deploy-preview', false], ['branch-deploy', false], ['production', false], ['production', true]] as const) {
      const result = await health(req(), { deploy: { context, published } } as Context);
      assert.equal(result.status, 503);
      assert.deepEqual(await result.json(), { error: 'service_not_configured' });
    }
    values.HEALTH_API_ENABLED = 'false';
    assert.equal((await health(req(), { deploy: { context: 'production', published: true } } as Context)).status, 503);
  } finally {
    if (original) Object.defineProperty(globalThis, 'Netlify', original);
    else Reflect.deleteProperty(globalThis, 'Netlify');
  }
});
