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
import { enumerateAddressableModelIds, listedRealModels } from '../providers/addressable.ts';
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
  const [catalog, addressable, aliases] = await Promise.all([
    resolveCodexCatalog(userAgent),
    enumerateAddressableModelIds(upstreamIds, fetcherForUpstream, scheduler),
    getRepo().modelAliases.list(),
  ]);
  const realModels = listedRealModels(addressable);
  // Keyed on every addressable id (not just the listed surface): an alias can
  // legitimately target an unlisted addressable form — `gpt-5.4` when the
  // listed canonical id is `cust/gpt-5.4`, or a Copilot variant `claude-opus-4.7`
  // when the listed canonical is `claude-opus-4-7`. Each entry's `.model`
  // points to the same canonical `ResolvedModel`, so storing the limit under
  // both the listed id and any unlisted alias of it stays consistent.
  const slugContextWindow = new Map<string, number>();
  for (const entry of addressable) {
    const limit = entry.model.limits.max_context_window_tokens;
    if (typeof limit === 'number') slugContextWindow.set(entry.id, limit);
  }
  // Listed-surface filter for the codex catalog itself: the codex client
  // expects the surface it would have published in a regular /v1/models
  // call, so addressable-but-not-listed forms intentionally do NOT enter
  // this set.
  const registrySlugs = new Set(realModels.map(m => m.id));
  // Alias-target availability is the broader question — a target reachable
  // only via a prefix alternate or Copilot variant id still resolves at
  // request time, so the codex catalog must keep its alias slug too.
  const addressableSet = new Set(addressable.map(entry => entry.id));

  // Run the shared alias synthesizer so the codex catalog reads the same
  // visible-alias surface that /v1/models, the dashboard, and Gemini do.
  // Each entry's `aliasedFrom.targets` keeps every configured target — the
  // synthesizer does not narrow to availability — so we still pick the
  // first one in registry order here. Selection mode never matters for
  // this static listing: a `random` alias would refuse to publish a
  // stable context window, so the catalog uses first-available regardless
  // of the alias's runtime selection.
  //
  // We keep both the alias's own announced limits (operator override OR
  // the synthesizer's automatic intersection) AND the first routable
  // target's window — the resolver below prefers the alias's announced
  // value when the operator set it, fallback to the target's ceiling.
  interface AliasCatalogInfo {
    readonly firstTargetId: string;
    readonly announcedContextWindow: number | undefined;
  }
  const aliasCatalogInfo = new Map<string, AliasCatalogInfo>();
  for (const entry of synthesizeListedAliases({ aliases, addressableModelIds: addressable })) {
    const aliasedFrom = entry.aliasedFrom;
    if (aliasedFrom === undefined) continue;
    const firstRoutable = aliasedFrom.targets.find(t => addressableSet.has(t.target_model_id));
    if (firstRoutable === undefined) continue;
    aliasCatalogInfo.set(entry.id, {
      firstTargetId: firstRoutable.target_model_id,
      announcedContextWindow: entry.limits.max_context_window_tokens,
    });
  }

  const filtered: CodexCatalog = {
    models: catalog.models.filter(m => registrySlugs.has(m.slug) || aliasCatalogInfo.has(m.slug)),
  };

  // For an alias slug: prefer the alias's announced window — that's what
  // the operator told /v1/models to publish, and the codex client reads
  // this number for its own local gating (auto-compact, context-budget
  // UX), so the two wire surfaces must agree on operator intent. Fallback
  // to the first routable target's window when the alias has no announced
  // limit (e.g. multi-target alias with no operator override and no agreed
  // intersection). Plain (non-alias) slugs read straight off the registry.
  const contextWindowOf: ContextWindowResolver = slug => {
    const info = aliasCatalogInfo.get(slug);
    if (info !== undefined) return info.announcedContextWindow ?? slugContextWindow.get(info.firstTargetId) ?? null;
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
