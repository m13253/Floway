import { type Context, Hono, type Next } from 'hono';

import { createKey, deleteKey, listKeys, rotateKey, updateKey } from './api-keys/routes.ts';
import { authLogin, authLogout, authMe } from './auth/routes.ts';
import { copilotQuota } from './copilot-quota/routes.ts';
import { exportData, importData } from './data-transfer/routes.ts';
import { controlPlaneModels } from './models/routes.ts';
import { performanceOverview, performanceTelemetry } from './performance/routes.ts';
import { authLoginBody, changeOwnPasswordBody, codexImportBody, codexPkceStartBody, codexRefreshNowBody, codexReimportBody, copilotAuthPollBody, createKeyBody, createUpstreamBody, createUserBody, exportQuery, fetchModelsBody, importBody, performanceQuery, searchConfigSchema, searchUsageQuery, tokenUsageQuery, updateKeyBody, updateUpstreamBody, updateUserBody } from './schemas.ts';
import { getSearchConfigRoute, putSearchConfigRoute, testSearchConfigRoute } from './search-config/routes.ts';
import { searchUsage } from './search-usage/routes.ts';
import { tokenUsage } from './token-usage/routes.ts';
import { codexImport, codexPkceStart, codexRefreshNow, codexReimport, copilotAuthPoll, copilotAuthStart, createUpstream, deleteUpstream, fetchModels, listOptionalFlags, listUpstreamModels, listUpstreamOptions, listUpstreams, updateUpstream } from './upstreams/routes.ts';
import { changeOwnPassword, createUser, deleteUser, listUsers, updateUser } from './users/routes.ts';
import { zValidator } from '../middleware/zod-validator.ts';

const adminOnlyMiddleware = async (c: Context, next: Next) => {
  if (!c.get('isAdmin')) {
    return c.json({ error: 'Admin privileges required' }, 403);
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
  // Fallback 204 until a static favicon is committed and shadows this route.
  .get('/favicon.ico', () => new Response(null, { status: 204 }))
  .post('/auth/login', zValidator('json', authLoginBody), authLogin)
  .post('/auth/logout', authLogout)
  .get('/auth/me', authMe)
  // Defensive admin guard: any future /auth/* path not registered above
  // returns 403 instead of leaking through as a control-plane endpoint.
  .route('/auth', new Hono().use('*', adminOnlyMiddleware))
  .get('/api/keys', listKeys)
  .post('/api/keys', zValidator('json', createKeyBody), createKey)
  .post('/api/keys/:id/rotate', rotateKey)
  .patch('/api/keys/:id', zValidator('json', updateKeyBody), updateKey)
  .delete('/api/keys/:id', deleteKey)
  .get('/api/token-usage', zValidator('query', tokenUsageQuery), tokenUsage)
  .get('/api/search-usage', zValidator('query', searchUsageQuery), searchUsage)
  .get('/api/performance', zValidator('query', performanceQuery), performanceTelemetry)
  .get('/api/performance/overview', zValidator('query', performanceQuery), performanceOverview)
  .get('/api/models', controlPlaneModels)
  // Minimal upstream picker exposed to non-admin users so they can scope a key
  // to specific upstreams. Returns id/name/provider/enabled only — no config,
  // no flag overrides, no model lists. Server-side validation (api-keys'
  // `upstream_ids ⊆ user.upstreamIds` check) is the real authorization gate;
  // this endpoint just feeds the picker UI.
  .get('/api/upstream-options', listUpstreamOptions)
  // Self-service password change is session-only (the current-password check
  // pairs with a logged-in dashboard session); admins reset other users'
  // passwords through PATCH /api/users/:id below, which is admin-gated.
  .patch('/api/users/me/password', zValidator('json', changeOwnPasswordBody), changeOwnPassword)
  .route('/api', new Hono()
    .use('*', adminOnlyMiddleware)
    .get('/users', listUsers)
    .post('/users', zValidator('json', createUserBody), createUser)
    .patch('/users/:id', zValidator('json', updateUserBody), updateUser)
    .delete('/users/:id', deleteUser)
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
    .get('/search-config', getSearchConfigRoute)
    .put('/search-config', zValidator('json', searchConfigSchema), putSearchConfigRoute)
    .post('/search-config/test', zValidator('json', searchConfigSchema), testSearchConfigRoute)
    .get('/export', zValidator('query', exportQuery), exportData)
    .post('/import', zValidator('json', importBody), importData));

export type ControlPlaneRoutes = typeof controlPlaneRoutes;
