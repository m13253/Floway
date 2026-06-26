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
import type { ModelAliasRecord } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { getInternalModels } from '../providers/registry.ts';
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

// First currently-routable target's id, or null when no target resolves
// against the registry. Single-target aliases collapse to the lone target;
// multi-target aliases pick first-available (the order the operator
// configured). This drives both the slug-survives filter and the
// context-window resolver.
const firstAvailableTargetId = (alias: ModelAliasRecord, registrySlugs: ReadonlySet<string>): string | null => {
  for (const target of alias.targets) {
    if (registrySlugs.has(target.target_model_id)) return target.target_model_id;
  }
  return null;
};

const computeCatalog = async (
  userAgent: string | undefined,
  upstreamIds: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<CodexCatalog> => {
  const [catalog, internalModels, aliases] = await Promise.all([
    resolveCodexCatalog(userAgent),
    getInternalModels(upstreamIds, fetcherForUpstream, scheduler),
    getRepo().modelAliases.list(),
  ]);
  const slugContextWindow = new Map<string, number>();
  for (const m of internalModels) {
    const limit = m.limits.max_context_window_tokens;
    if (typeof limit === 'number') slugContextWindow.set(m.id, limit);
  }
  const registrySlugs = new Set(internalModels.map(m => m.id));

  // Visible aliases whose first target currently resolves — keyed by alias
  // name so the slug filter and the context-window resolver both look the
  // same alias up in O(1).
  const aliasBySlug = new Map<string, { alias: ModelAliasRecord; firstTargetId: string }>();
  for (const alias of aliases) {
    if (!alias.visibleInModelsList) continue;
    const firstTargetId = firstAvailableTargetId(alias, registrySlugs);
    if (firstTargetId === null) continue;
    aliasBySlug.set(alias.name, { alias, firstTargetId });
  }

  const filtered: CodexCatalog = {
    models: catalog.models.filter(m => registrySlugs.has(m.slug) || aliasBySlug.has(m.slug)),
  };

  // For an alias slug: prefer the operator's announced override, else the
  // first available target's window. Falls back to the registry-side lookup
  // for plain (non-alias) slugs.
  const contextWindowOf: ContextWindowResolver = slug => {
    const aliasEntry = aliasBySlug.get(slug);
    if (aliasEntry !== undefined) {
      const overridden = aliasEntry.alias.announcedMetadata?.limits?.max_context_window_tokens;
      if (typeof overridden === 'number') return overridden;
      return slugContextWindow.get(aliasEntry.firstTargetId) ?? null;
    }
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
