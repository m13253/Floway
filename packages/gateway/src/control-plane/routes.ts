import { type Context, Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { createProxy, deleteProxy, listAllBackoffs, listProxies, listProxyBackoffs, resetProxyBackoffs, testProxy, updateProxy } from './proxies/routes.ts';
import { authLoginBody, codexImportBody, codexPkceStartBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createKeyBody, createProxyBody, createUpstreamBody, exportQuery, fetchModelsBody, importBody, performanceQuery, resetBackoffBody, searchConfigSchema, searchUsageQuery, testProxyBody, tokenUsageQuery, updateKeyBody, updateProxyBody, updateUpstreamBody } from './schemas.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { codexImport, codexPkceStart, codexRefreshNow, codexReimport, copilotAuthPoll, copilotAuthStart, createUpstream, deleteUpstream, fetchModels, listOptionalFlags, listUpstreamModels, listUpstreams, updateUpstream } from './upstreams/routes.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const adminOnlyMiddleware = async (c: Context, next: Next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Dashboard key required' }, 403);
  }
  await next();
};

// Chained route registration is required for Hono RPC to flow the per-path
// types into `typeof controlPlaneRoutes`, which apps/web consumes as the
// AppType generic parameter of `hc<AppType>()` to get path/method autocomplete
// and request/response inference. Each route that takes a body or query string
// declares its shape via zValidator(target, schema); the schemas live in
// ./schemas.ts and double as the RPC client's input contract.
export const controlPlaneRoutes = new Hono()
  .get('/api/health', c => c.json({ status: 'ok', service: 'floway' }))
  // Fallback while no static favicon is committed to apps/web/src/. Once
  // Vite copies a real favicon into apps/web/dist/, Workers Static Assets
  // will match first and this handler becomes dead code.
  .get('/favicon.ico', () => new Response(null, { status: 204 }))
  .post('/auth/login', zValidator('json', authLoginBody), authLogin)
  .post('/auth/logout', authLogout)
  .get('/auth/me', authMe)
  // Defensive admin guard for any /auth/* path not registered above.
  .route('/auth', new Hono().use('*', adminOnlyMiddleware))
  .get('/api/keys', listKeys)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage)
  .get('/api/performance', zValidator('query', performanceQuery), performanceTelemetry)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', controlPlaneModels)
  .route('/api', new Hono()
    .use('*', adminOnlyMiddleware)
    .post('/keys', zValidator('json', createKeyBody), createKey)
    .post('/keys/:id/rotate', rotateKey)
    .patch('/keys/:id', zValidator('json', updateKeyBody), updateKey)
    .delete('/keys/:id', deleteKey)
    .get('/upstreams', listUpstreams)
    .get('/upstream-flags', listOptionalFlags)
    .post('/upstreams/copilot/auth/start', copilotAuthStart)
    .post('/upstreams/copilot/auth/poll', zValidator('json', copilotAuthPollBody), copilotAuthPoll)
    .post('/upstreams/codex-pkce-start', zValidator('json', codexPkceStartBody), codexPkceStart)
    .post('/upstreams/codex-import', zValidator('json', codexImportBody), codexImport)
    .post('/upstreams/:id/codex-reimport', zValidator('json', codexReimportBody), codexReimport)
    .post('/upstreams/:id/codex-refresh-now', zValidator('json', codexRefreshNowBody), codexRefreshNow)
    .post('/upstreams/fetch-models', zValidator('json', fetchModelsBody), fetchModels)
    .post('/upstreams', zValidator('json', createUpstreamBody), createUpstream)
    .get('/upstreams/:id/copilot/quota', copilotQuota)
    .get('/upstreams/:id/models', listUpstreamModels)
    .patch('/upstreams/:id', zValidator('json', updateUpstreamBody), updateUpstream)
    .delete('/upstreams/:id', deleteUpstream)
    // Proxies. Literal `/proxies/backoffs` and the per-id sub-paths are
    // registered before the catch-all `/:id` routes so Hono matches the
    // literal segments first; same constraint applies to test/backoffs/reset
    // before the bare PATCH/DELETE on `/:id`.
    .get('/proxies', listProxies)
    .get('/proxies/backoffs', listAllBackoffs)
    .post('/proxies', zValidator('json', createProxyBody), createProxy)
    .post('/proxies/:id/test', zValidator('json', testProxyBody), testProxy)
    .post('/proxies/:id/backoffs/reset', zValidator('json', resetBackoffBody), resetProxyBackoffs)
    .get('/proxies/:id/backoffs', listProxyBackoffs)
    .patch('/proxies/:id', zValidator('json', updateProxyBody), updateProxy)
    .delete('/proxies/:id', deleteProxy)
    .get('/search-config', getSearchConfigRoute)
    .put('/search-config', zValidator('json', searchConfigSchema), putSearchConfigRoute)
    .post('/search-config/test', zValidator('json', searchConfigSchema), testSearchConfigRoute)
    .get('/export', zValidator('query', exportQuery), exportData)
    .post('/import', zValidator('json', importBody), importData));

export type ControlPlaneRoutes = typeof controlPlaneRoutes;
