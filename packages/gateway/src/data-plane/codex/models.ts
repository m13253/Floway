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

import type { Context } from 'hono';

import { CODEX_AUTO_REVIEW_ALIAS, CODEX_AUTO_REVIEW_TARGET } from './auto-review-alias.ts';
import { resolveCodexCatalog, type CatalogModel, type CodexCatalog } from './catalog.ts';
import { applyContextWindowFromRegistry, type ContextWindowResolver } from './context-window.ts';
import { synthesizeCatalogEntry, deriveServiceTiers } from './synthesize.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { effectiveUpstreamIdsFromContext } from '../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getCurrentColo } from '../../runtime/runtime-info.ts';
import { getInternalModels } from '../providers/registry.ts';
import type { InternalModel } from '@floway-dev/provider';

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
  const slugContextWindow = new Map<string, number>();
  let aliasTarget: InternalModel | null = null;
  for (const im of internalModels) {
    if (im.kind !== 'chat') continue;
    const limit = im.limits.max_context_window_tokens;
    if (typeof limit === 'number') slugContextWindow.set(im.id, limit);
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
      if (im.id.toLowerCase() === CODEX_AUTO_REVIEW_TARGET) aliasTarget = im;
    } else {
      models.push(synthesizeCatalogEntry(im));
    }
  }
  if (aliasTarget !== null) {
    const aliasEntry = bundledBySlug.get(CODEX_AUTO_REVIEW_ALIAS);
    if (aliasEntry === undefined) {
      throw new Error(`Bundled Codex catalog missing required alias entry for slug "${CODEX_AUTO_REVIEW_ALIAS}"`);
    }
    // The alias points at the same upstream model as its target — bill via
    // the same registry tiers, not the bundled ones (which may advertise
    // OpenAI 1p tiers Floway cannot bill).
    models.push({ ...aliasEntry, service_tiers: deriveServiceTiers(aliasTarget) });
  }
  const contextWindowOf: ContextWindowResolver = slug =>
    slugContextWindow.get(slug === CODEX_AUTO_REVIEW_ALIAS ? CODEX_AUTO_REVIEW_TARGET : slug) ?? null;
  return applyContextWindowFromRegistry({ models }, contextWindowOf);
};

export const codexModels = async (c: Context): Promise<Response> => {
  const userAgent = c.req.header('user-agent');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const fetcherForUpstream = await createPerRequestFetcher(getCurrentColo(c.req.raw));
  const scheduler = backgroundSchedulerFromContext(c);
  const [bundled, internalModels] = await Promise.all([
    resolveCodexCatalog(userAgent),
    getInternalModels(upstreamIds, fetcherForUpstream, scheduler),
  ]);
  return Response.json(computeCatalog(bundled, internalModels));
};
