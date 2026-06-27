// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a bundled catalog per release (see catalog.ts);
// we filter that catalog down to the slugs the registry actually advertises
// (so the codex client never sees a model the gateway can't serve), then
// rewrite each entry's `context_window` / `max_context_window` from the
// registry (see context-window.ts) so the codex client sees the same
// limits the data plane will actually enforce.
//
// Operator-defined aliases participate in the same filter: a bundled
// catalog slug that matches a visible alias survives whenever the alias
// has at least one currently-routable target, and the context window the
// alias advertises follows the alias's announced metadata (when the
// operator overrode it) or the first available target (single-target
// aliases collapse to "the target's window"; multi-target aliases pick
// first-available for determinism — `random` doesn't fit a catalog).
//
// Latency: codex aborts the catalog fetch after 5 s
// (`MODELS_REFRESH_TIMEOUT` in codex-rs/model-provider/src/models_endpoint.rs)
// and silently falls back to its binary-bundled catalog on miss. The
// registry leg can cost ~4 s on a slow path, leaving almost no margin
// once Worker cold-start is added on top. We cache the resolved response
// in the per-colo Cache API keyed on `(client_version, upstream filter)`
// so the slow path runs at most once per colo per cache window; subsequent
// callers get the cached body in milliseconds and the registry call is
// skipped entirely.

import type { Context } from 'hono';

import { parseCodexVersion, resolveCodexCatalog, type CodexCatalog } from './catalog.ts';
import { applyContextWindowFromRegistry, type ContextWindowResolver } from './context-window.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { getRepo } from '../../repo/index.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { synthesizeListedAliases } from '../models/alias-listing.ts';
import { getModels } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher } from '@floway-dev/provider';

// Five minutes is short enough to pick up an upstream catalog change within
// one or two codex sessions but long enough that an active user only ever
// pays the slow path on the first request after a deploy or a quiet hour.
const CACHE_TTL_SECONDS = 300;

const cacheKeyFor = (clientVersion: string, upstreamIds: readonly string[] | null): Request => {
  const ids = upstreamIds === null ? 'all' : [...upstreamIds].sort().join(',');
  // Synthetic URL: never resolves on the public internet, only used as the
  // Workers Cache API key. Auth headers on the original request never enter
  // this key, so two clients with different api keys but the same upstream
  // filter share the cache entry.
  return new Request(`https://floway.invalid/codex-models?v=${encodeURIComponent(clientVersion)}&u=${encodeURIComponent(ids)}`);
};

const computeCatalog = async (
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<CodexCatalog> => {
  const [catalog, realModels, aliases] = await Promise.all([
    resolveCodexCatalog(userAgent),
    getModels(upstreamIds, fetcherForUpstream, scheduler),
    getRepo().modelAliases.list(),
  ]);
  const slugContextWindow = new Map<string, number>();
  for (const m of realModels) {
    const limit = m.limits.max_context_window_tokens;
    if (typeof limit === 'number') slugContextWindow.set(m.id, limit);
  }
  const registrySlugs = new Set(realModels.map(m => m.id));

  // Run the shared alias synthesizer so the codex catalog reads the same
  // visible-alias surface that /v1/models, the dashboard, and Gemini do.
  // Each entry's `aliasedFrom.targets` keeps every configured target — the
  // synthesizer does not narrow to availability — so we still pick the
  // first one in registry order here. Selection mode never matters for
  // this static listing: a `random` alias would refuse to publish a
  // stable context window, so the catalog uses first-available regardless
  // of the alias's runtime selection.
  const aliasFirstTarget = new Map<string, string>();
  for (const entry of synthesizeListedAliases({ aliases, realModels })) {
    const aliasedFrom = entry.aliasedFrom;
    if (aliasedFrom === undefined) continue;
    const firstRoutable = aliasedFrom.targets.find(t => registrySlugs.has(t.target_model_id));
    if (firstRoutable !== undefined) aliasFirstTarget.set(entry.id, firstRoutable.target_model_id);
  }

  const filtered: CodexCatalog = {
    models: catalog.models.filter(m => registrySlugs.has(m.slug) || aliasFirstTarget.has(m.slug)),
  };

  // For an alias slug: redirect to the first routable target's window so
  // the published number is one the gateway can honour. Plain (non-alias)
  // slugs read straight off the registry. Operator-set overrides on the
  // alias's announced metadata travel through `synthesizeListedAliases`
  // into the alias entry's own limits — but the codex catalog needs the
  // *target's* window here, not the alias's announced one, because
  // `applyContextWindowFromRegistry` writes both `context_window` and
  // `max_context_window` and the upstream binding only enforces the
  // target's real ceiling.
  const contextWindowOf: ContextWindowResolver = slug => {
    const firstTargetId = aliasFirstTarget.get(slug);
    if (firstTargetId !== undefined) return slugContextWindow.get(firstTargetId) ?? null;
    return slugContextWindow.get(slug) ?? null;
  };
  return applyContextWindowFromRegistry(filtered, contextWindowOf);
};

export const codexModels = async (c: Context): Promise<Response> => {
  const userAgent = c.req.header('user-agent');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const cache = (globalThis as { caches?: { default?: Cache } }).caches?.default ?? null;
  const cacheKey = cache === null ? null : cacheKeyFor(
    c.req.query('client_version') ?? parseCodexVersion(userAgent) ?? 'unknown',
    upstreamIds,
  );

  if (cache !== null && cacheKey !== null) {
    const hit = await cache.match(cacheKey);
    if (hit !== undefined) return hit;
  }

  const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
  const scheduler = backgroundSchedulerFromContext(c);
  const response = Response.json(await computeCatalog(userAgent, upstreamIds, fetcherForUpstream, scheduler), {
    headers: { 'cache-control': `public, max-age=${CACHE_TTL_SECONDS}` },
  });
  if (cache !== null && cacheKey !== null) {
    scheduler(cache.put(cacheKey, response.clone()));
  }
  return response;
};
