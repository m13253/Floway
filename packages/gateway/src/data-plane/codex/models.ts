// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// Pipeline: codex publishes a bundled catalog per release (see catalog.ts);
// for each chat-kind model the registry advertises, we either reuse its
// bundled entry (found via segment-based slug matching) or synthesize a new
// one (see synthesize.ts). Bundled entries have their slug overridden to the
// registry public id and their context_window / max_context_window rewritten
// from the registry (see context-window.ts) so the codex client sees the
// same limits the data plane will actually enforce.
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

import { CODEX_AUTO_REVIEW_ALIAS, CODEX_AUTO_REVIEW_TARGET } from './auto-review-alias.ts';
import { parseCodexVersion, resolveCodexCatalog, type CatalogModel, type CodexCatalog } from './catalog.ts';
import { applyContextWindowFromRegistry, type ContextWindowResolver } from './context-window.ts';
import { synthesizeCatalogEntry, deriveServiceTiers } from './synthesize.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { getInternalModels } from '../providers/registry.ts';
import type { InternalModel } from '@floway-dev/provider';

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

// Pure function over already-resolved inputs — the request handler does the
// I/O, this does the catalog shape.
export const computeCatalog = (
  bundled: CodexCatalog,
  internalModels: readonly InternalModel[],
): CodexCatalog => {
  const bundledBySlug = new Map<string, CatalogModel>();
  for (const m of bundled.models) bundledBySlug.set(m.slug.toLowerCase(), m);

  const matchBundled = (publicId: string): CatalogModel | null => {
    for (const seg of publicId.toLowerCase().split(/[/:]/)) {
      if (seg === '') continue;
      const hit = bundledBySlug.get(seg);
      if (hit) return hit;
    }
    return null;
  };

  const models: CatalogModel[] = [];
  let aliasActive = false;
  for (const im of internalModels) {
    if (im.kind !== 'chat') continue;
    const hit = matchBundled(im.id);
    if (hit) {
      const cloned: CatalogModel = { ...hit, slug: im.id };
      if (im.display_name !== undefined) cloned.display_name = im.display_name;
      // Registry-derived tiers win over bundled: a tier we can bill must
      // have unit prices in the registry, so any bundled tier we lack
      // pricing for cannot be surfaced to the client.
      cloned.service_tiers = deriveServiceTiers(im);
      models.push(cloned);
      // The alias entry itself does not trigger an extra alias append. Only a
      // registry model whose public id is exactly the alias target triggers it
      // — a prefixed id like `azure/gpt-5.4` routes through the target but
      // the Codex CLI's auto-review hook only fires when it can send the bare
      // `codex-auto-review` slug, so the bare target must appear in the
      // registry.
      if (im.id.toLowerCase() === CODEX_AUTO_REVIEW_TARGET) aliasActive = true;
    } else {
      models.push(synthesizeCatalogEntry(im));
    }
  }
  if (aliasActive) {
    const aliasEntry = bundledBySlug.get(CODEX_AUTO_REVIEW_ALIAS);
    if (aliasEntry === undefined) {
      throw new Error(`Bundled Codex catalog missing required alias entry for slug "${CODEX_AUTO_REVIEW_ALIAS}"`);
    }
    models.push({ ...aliasEntry });
  }
  const slugContextWindow = new Map<string, number>();
  for (const m of internalModels) {
    const limit = m.limits.max_context_window_tokens;
    if (typeof limit === 'number') slugContextWindow.set(m.id, limit);
  }
  const contextWindowOf: ContextWindowResolver = slug =>
    slugContextWindow.get(slug === CODEX_AUTO_REVIEW_ALIAS ? CODEX_AUTO_REVIEW_TARGET : slug) ?? null;
  return applyContextWindowFromRegistry({ models }, contextWindowOf);
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
  const [bundled, internalModels] = await Promise.all([
    resolveCodexCatalog(userAgent),
    getInternalModels(upstreamIds, fetcherForUpstream, scheduler),
  ]);
  const response = Response.json(computeCatalog(bundled, internalModels), {
    headers: { 'cache-control': `public, max-age=${CACHE_TTL_SECONDS}` },
  });
  if (cache !== null && cacheKey !== null) {
    scheduler(cache.put(cacheKey, response.clone()));
  }
  return response;
};
