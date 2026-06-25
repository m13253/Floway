import { fetchUpstreamModelsCached } from './models-cache.ts';
import type { ModelAlias, ModelAliasRules } from '../../control-plane/model-aliases/types.ts';
import { getRepo } from '../../repo/index.ts';
import { matchAlias } from '../model-aliases/match.ts';
import { synthesizeListedAliases, type ListedModel } from '../models/alias-listing.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type ModelEndpointKey, type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import type { InternalModel, ModelProviderInstance, ProviderModelRecord, ResolvedModel, Fetcher, UpstreamModel, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { createAzureProvider } from '@floway-dev/provider-azure';
import { createClaudeCodeProvider } from '@floway-dev/provider-claude-code';
import { createCodexProvider } from '@floway-dev/provider-codex';
import { createCopilotProvider } from '@floway-dev/provider-copilot';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { createOllamaProvider } from '@floway-dev/provider-ollama';

interface ProviderModelsResult {
  models: ResolvedModel[];
  sawSuccess: boolean;
  lastError: unknown;
  // Upstream names whose catalog fetch rejected this round, in the same
  // order as the input `providers` list so the model-missing renderer can
  // surface a stable, dashboard-aligned list.
  failedUpstreams: string[];
  // Raw per-upstream catalogs collected during the fan-out. Aliases consume
  // this to enumerate per-upstream entries by addressable form without paying
  // a second round-trip.
  rawCatalogs: Map<string, readonly UpstreamModel[]>;
}

const NO_UPSTREAM_CONFIGURED_MESSAGE = 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard';

type ProviderFactory = (record: UpstreamRecord) => ModelProviderInstance | Promise<ModelProviderInstance>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
  codex: createCodexProvider,
  'claude-code': createClaudeCodeProvider,
  ollama: createOllamaProvider,
};

export const createProviderInstance = (record: UpstreamRecord): ModelProviderInstance | Promise<ModelProviderInstance> =>
  providerFactories[record.provider](record);

// The upstream scope is a required argument across the catalog-assembly chain
// (this, getModels, getInternalModels) so a caller can never omit it and
// silently receive the full, unscoped catalog — a missing scope is a compile
// error, not a runtime leak. Pass `null` to deliberately request every enabled
// upstream.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
): Promise<ModelProviderInstance[]> => {
  const upstreams = await getRepo().upstreams.list();
  const enabledById = new Map<string, UpstreamRecord>();
  const knownIds = new Set<string>();
  for (const upstream of upstreams) {
    knownIds.add(upstream.id);
    if (upstream.enabled) enabledById.set(upstream.id, upstream);
  }

  let selection: UpstreamRecord[];
  if (upstreamFilter) {
    // Unknown ids are a caller-side configuration error (the filter is the
    // intersection of per-user + per-api-key caps; both reference upstreams
    // by id); surface them so the operator notices instead of silently
    // serving a smaller subset. Disabled-but-known ids stay silent: a user
    // cap may legitimately mention an upstream the operator just disabled.
    const unknown = upstreamFilter.filter(id => !knownIds.has(id));
    if (unknown.length > 0) {
      throw new Error(`Unknown upstream id(s) in filter: ${unknown.join(', ')}`);
    }
    selection = upstreamFilter
      .map(id => enabledById.get(id))
      .filter((u): u is UpstreamRecord => u !== undefined);
  } else {
    selection = [...enabledById.values()];
  }

  const providers: ModelProviderInstance[] = [];
  for (const upstream of selection) {
    const factory = providerFactories[upstream.provider];
    providers.push(await factory(upstream));
  }

  return providers;
};

// Merge two capability maps: a key present in either side is present in the
// result, and its sub-capability flags are OR-ed so a sub-cap advertised by
// either provider survives.
export const unionEndpoints = (a: ModelEndpoints, b: ModelEndpoints): ModelEndpoints => {
  const result: ModelEndpoints = { ...a };
  for (const key of Object.keys(b) as ModelEndpointKey[]) {
    const merged = { ...result[key], ...b[key] };
    (result as Record<ModelEndpointKey, object>)[key] = merged;
  }
  return result;
};

const resolvedFromUpstreamModel = (upstreamModel: UpstreamModel, record: ProviderModelRecord): ResolvedModel => {
  const { providerData: _providerData, endpoints, ...internal } = upstreamModel;
  return {
    ...internal,
    endpoints: { ...endpoints },
    providers: [record],
  };
};

const providerModelRecord = (instance: ModelProviderInstance, upstreamModel: UpstreamModel): ProviderModelRecord => ({
  upstream: instance.upstream,
  upstreamName: instance.name,
  providerKind: instance.providerKind,
  provider: instance.provider,
  upstreamModel,
  enabledFlags: upstreamModel.enabledFlags,
  supportsResponsesItemReference: instance.supportsResponsesItemReference,
});

// When multiple upstreams expose the same public model id, the first wins
// for /models metadata and later ones union-merge their endpoints + provider
// binding. Runtime execution still uses each provider's own UpstreamModel, so
// capability-sensitive calls do not depend on this merged view.
const mergeIntoCatalog = (
  byId: Map<string, ResolvedModel>,
  instance: ModelProviderInstance,
  surfacedModel: UpstreamModel,
  publicId: string,
): void => {
  const record = providerModelRecord(instance, surfacedModel);
  const existing = byId.get(publicId);
  if (!existing) {
    byId.set(publicId, resolvedFromUpstreamModel(surfacedModel, record));
    return;
  }
  const endpoints = unionEndpoints(existing.endpoints, surfacedModel.endpoints);
  byId.set(publicId, {
    ...existing,
    endpoints,
    kind: kindForEndpoints(endpoints),
    providers: [...existing.providers, record],
  });
};

const collectProviderModels = async (
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, ResolvedModel>();
  const rawCatalogs = new Map<string, readonly UpstreamModel[]>();
  let sawSuccess = false;
  let lastError: unknown = null;
  const failedUpstreams: string[] = [];

  // Fan out per-upstream so a slow provider does not stall the rest. The SWR
  // cache layer dedupes concurrent in-flight fetches per upstream and serves
  // the SOFT-fresh row without an upstream round trip, so the parallel walk
  // is cheap on the warm path and bounded by `max(per-upstream fetch)` on
  // the cold path.
  const fetchOne = (instance: ModelProviderInstance) =>
    fetchUpstreamModelsCached(instance, {
      scheduler,
      fetcher: fetcherForUpstream(instance.upstream),
    }).then(models => ({ instance, models }));

  const settled = await Promise.allSettled(providers.map(fetchOne));

  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      // Caller-driven cancellation must propagate. Burying it in lastError
      // and letting an earlier sawSuccess return a partially-populated
      // model list would mask the abort and let the rest of the data-plane
      // request build a Response against a stale catalog.
      const error = result.reason;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      lastError = error;
      failedUpstreams.push(providers[index].name);
      continue;
    }
    sawSuccess = true;
    const { instance, models: providedModels } = result.value;
    rawCatalogs.set(instance.upstream, providedModels);
    // Operator-disabled public model ids vanish entirely for this upstream:
    // dropped before they reach the catalog map, so they appear in no /models
    // listing and resolve to nothing for routing. The disable is per-upstream,
    // so the same id can still surface from another upstream that allows it.
    // The disable matches against the bare upstream id, so a disabled `gpt-4o`
    // hides both `gpt-4o` and `<prefix>gpt-4o` from this upstream's
    // contribution.
    const disabled = new Set(instance.disabledPublicModelIds);
    for (const upstreamModel of providedModels) {
      if (!upstreamModel.id) continue;
      if (disabled.has(upstreamModel.id)) continue;

      // Each surface form the upstream chose to list becomes its own catalog
      // entry. The unprefixed surface keeps the original UpstreamModel; the
      // prefixed surface uses a shallow clone with the rewritten id and a
      // synthesized display_name that prepends the upstream name (so the
      // dashboard tells the operator at a glance which upstream a prefixed
      // model came from). `providerData` (where the per-provider call reads
      // the real upstream model id) is untouched by the clone.
      const cfg = instance.modelPrefix;
      if (cfg !== null) {
        for (const form of cfg.listed) {
          const publicId = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
          const surfacedModel: UpstreamModel = form === 'prefixed'
            ? { ...upstreamModel, id: publicId, display_name: `${instance.name}: ${upstreamModel.display_name ?? upstreamModel.id}` }
            : upstreamModel;
          mergeIntoCatalog(byId, instance, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(byId, instance, upstreamModel, upstreamModel.id);
      }
    }
  }

  return { models: [...byId.values()], sawSuccess, lastError, failedUpstreams, rawCatalogs };
};

// Public-facing model-id ordering, applied in getModels() to every list that
// crosses a gateway boundary (data-plane /v1/models, /models, /v1beta/models
// and the control-plane /api/models that backs the dashboard models page).
// Provider upstreams return models in arbitrary order; sorting here gives the
// dashboard and downstream clients a stable, family-grouped view.
//
// Sort keys, evaluated in order:
//   0. Whether the id contains a '/'. Slashed ids (Microsoft Foundry router
//      model ids like "accounts/msft/routers/x") are pushed to the tail so
//      the typical flat ids stay on top.
//   1. Leading [a-zA-Z]+ prefix, case-insensitive, ascending. Groups model
//      families: "claude-haiku-4-5" -> "claude", "deepseek-v4-pro" ->
//      "deepseek".
//   2. Array of isolated single digits (a digit surrounded on both sides by a
//      non-digit, with start/end of string counting as non-digit), compared
//      element by element as integers, DESCENDING — newer/larger versions
//      first: "claude-opus-4-7" -> [4, 7] beats "claude-opus-4-5" -> [4, 5];
//      "gpt-5.5" -> [5, 5] beats "gpt-4o" -> [4]. Multi-digit runs (dates,
//      "20300101") are intentionally not counted as version parts.
//   3. Full string lex order, DESCENDING, case-folded first then raw — keeps
//      "GPT-4o" and "gpt-4o" adjacent while giving longer/later suffixes
//      priority within an otherwise tied group.
export const compareModelIds = (a: string, b: string): number => {
  const cmp = <T>(x: T, y: T, dir = 1) => (x < y ? -dir : x > y ? dir : 0);
  const prefix = (s: string) => /^[a-zA-Z]+/.exec(s)?.[0].toLowerCase() ?? '';
  const digits = (s: string) => [...s.matchAll(/(?<!\d)\d(?!\d)/g)].map(m => +m[0]);
  const [da, db] = [digits(a), digits(b)];
  return cmp(+a.includes('/'), +b.includes('/'))
    || cmp(prefix(a), prefix(b))
    || (da.slice(0, Math.min(da.length, db.length)).map((v, i) => db[i] - v).find(d => d !== 0) ?? db.length - da.length)
    || cmp(a.toLowerCase(), b.toLowerCase(), -1)
    || cmp(a, b, -1);
};

// `fetcherForUpstream` routes each upstream's catalog fetch through its
// per-upstream proxy chain.
export const getModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ResolvedModel[]> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, sawSuccess, lastError } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  if (sawSuccess) return models.sort((a, b) => compareModelIds(a.id, b.id));
  if (lastError) throw lastError;
  return [];
};

// Returns the merged public model list AND the per-upstream raw catalogs and
// provider instances. Listing surfaces (`/v1/models`, `/api/models`, Gemini
// `/models`) use the same call so alias entries — synthesized once via
// `synthesizeListedAliases` against the same `(providers, rawCatalogs)` pair —
// are interleaved into the catalog before it returns. Per-surface mappers
// then walk one uniform `ListedModel[]` instead of re-implementing alias
// fan-out three times.
export interface PublicModelsListing {
  models: ListedModel[];
  providers: readonly ModelProviderInstance[];
  rawCatalogs: ReadonlyMap<string, readonly UpstreamModel[]>;
}

export const getModelsForListing = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[],
): Promise<PublicModelsListing> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, sawSuccess, lastError, rawCatalogs } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  if (sawSuccess) {
    const real = models.sort((a, b) => compareModelIds(a.id, b.id));
    const aliasEntries = synthesizeListedAliases(aliases, providers, rawCatalogs);
    return { models: [...real, ...aliasEntries], providers, rawCatalogs };
  }
  if (lastError) throw lastError;
  return { models: [], providers, rawCatalogs };
};

export const getInternalModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<InternalModel[]> =>
  (await getModels(upstreamFilter, fetcherForUpstream, scheduler)).map(({ providers: _providers, endpoints: _endpoints, ...model }) => model);

interface ModelResolution {
  matches: readonly ProviderModelResolution[];
  // Upstream names whose catalog fetch rejected during this resolution.
  // Threaded out so the caller's failure renderer can mention them
  // parenthetically — same data the dashboard's `modelsCache.lastError`
  // surfaces, but inlined into the per-request 404/400 so a client sees
  // why their model might be temporarily missing.
  failedUpstreams: readonly string[];
}

export interface ProviderModelResolution {
  id: string;
  model: UpstreamModel;
  binding: ProviderModelRecord;
  // Set when this resolution came from an alias-rewrite interpretation. The
  // gateway-side passthrough callers (embeddings/images/completions) stamp
  // this onto the `x-floway-alias` response header so alias-served calls are
  // observable without enabling any extra mode.
  aliasName?: string;
}

export interface ModelInterpretation {
  provider: ModelProviderInstance;
  // The bare id to query the upstream's catalog with. Equals the inbound
  // model id for the unprefixed surface; equals `inbound.slice(prefix.length)`
  // for the prefixed surface. For an alias-rewrite interpretation it equals
  // the matched alias's `targetModelId`.
  lookupId: string;
  // Operator-locked request-time rules carried alongside an alias-rewrite
  // interpretation. Set only when this interpretation is the alias-rewrite
  // half of a matched alias; the real-name interpretation in the same
  // `conflictGroup` (and every non-aliased interpretation) leaves this
  // undefined.
  aliasRules?: ModelAliasRules;
  // The alias name as authored by the operator. Set in lockstep with
  // `aliasRules` and carried out for the `x-floway-alias` response header.
  aliasName?: string;
  // Identity-keyed group shared by the two interpretations a single
  // `onConflict: 'real-only'` alias emits. The post-resolution prune uses
  // this to drop the alias-rewrite member when both halves resolved.
  conflictGroup?: { readonly originalLookupId: string };
}

// Expands one inbound model id into every (provider, catalog-lookup-id) pair
// the upstream registry can interpret it as. A request matches an upstream
// when the inbound id literally equals one of the public-id surfaces the
// upstream advertises (bare and/or prefixed, per `modelPrefix.addressable`).
// The unprefixed interpretation is always pushed first when both apply.
//
// Each (provider, lookupId) candidate is then matched against the global
// alias table — semantic P, post-prefix-strip — and the matched alias's
// `onConflict` decides whether to push the real-name interpretation, the
// alias-rewrite interpretation, or both (in either order). When neither
// the alias nor the alias's target id is exposed by the upstream catalog,
// the fan-out still emits both interpretations and resolution simply
// drops the half that misses.
export const enumerateModelInterpretations = (
  modelId: string,
  providers: readonly ModelProviderInstance[],
  aliases: readonly ModelAlias[],
): ModelInterpretation[] => {
  const out: ModelInterpretation[] = [];
  for (const provider of providers) {
    const cfg = provider.modelPrefix;
    if (cfg === null || cfg.addressable.includes('unprefixed')) {
      pushInterpretation(out, provider, modelId, aliases);
    }
    if (cfg !== null && cfg.addressable.includes('prefixed') && modelId.startsWith(cfg.prefix)) {
      pushInterpretation(out, provider, modelId.slice(cfg.prefix.length), aliases);
    }
  }
  return out;
};

const pushInterpretation = (
  out: ModelInterpretation[],
  provider: ModelProviderInstance,
  lookupId: string,
  aliases: readonly ModelAlias[],
): void => {
  const alias = matchAlias(lookupId, provider.upstream, aliases);
  if (!alias) {
    out.push({ provider, lookupId });
    return;
  }
  const aliasInterp: ModelInterpretation = {
    provider,
    lookupId: alias.targetModelId,
    aliasRules: alias.rules,
    aliasName: alias.alias,
  };
  const realInterp: ModelInterpretation = { provider, lookupId };
  switch (alias.onConflict) {
  case 'alias-only':
    out.push(aliasInterp);
    return;
  case 'real-only': {
    // Both halves enter the resolution pass; the post-resolution prune
    // drops the alias-rewrite member when the real-name resolved too.
    // Identity-keyed group so the prune step can rejoin them without
    // re-deriving an alias key.
    const group = { originalLookupId: lookupId };
    out.push({ ...realInterp, conflictGroup: group });
    out.push({ ...aliasInterp, conflictGroup: group });
    return;
  }
  case 'both-real-first':
    out.push(realInterp);
    out.push(aliasInterp);
    return;
  case 'both-alias-first':
    out.push(aliasInterp);
    out.push(realInterp);
    return;
  default: {
    const exhaustive: never = alias.onConflict;
    throw new Error(`pushInterpretation: unhandled onConflict '${exhaustive as string}'`);
  }
  }
};

// Fan out per-interpretation against the SWR cache and collect the resolved
// matches plus a deduped list of upstreams whose catalog fetch rejected.
// Shared by `resolveModelForRequest` and `enumerateProviderCandidates`; the
// per-caller divergence (passthrough vs LLM-candidate shape) happens after
// this returns. Cancellation (`AbortError`) propagates so the per-request
// abort signal cannot be masked by a slow upstream's rejection.
//
// Each successful resolution carries its source `interpretation` back to
// the caller so the alias-rewrite metadata (`aliasRules`, `aliasName`)
// rides through to the candidate, and so the `real-only` post-resolution
// prune can rejoin the two halves of a conflict group.
export const collectInterpretationOutcomes = async (
  interpretations: readonly ModelInterpretation[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  resolutions: Array<{ interpretation: ModelInterpretation; provider: ModelProviderInstance; resolved: ProviderModelResolution }>;
  failedUpstreams: string[];
}> => {
  const settled = await Promise.allSettled(interpretations.map(interpretation =>
    resolveModelForProvider(interpretation.provider, interpretation.lookupId, fetcherForUpstream(interpretation.provider.upstream), scheduler)
      .then(resolved => ({ interpretation, resolved }))));

  const failedUpstreams: string[] = [];
  const failedSeen = new Set<string>();
  const resolutions: Array<{ interpretation: ModelInterpretation; provider: ModelProviderInstance; resolved: ProviderModelResolution }> = [];

  for (const [index, result] of settled.entries()) {
    if (result.status === 'rejected') {
      const error = result.reason;
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // A single upstream may produce multiple interpretations; surface its
      // failure once.
      const name = interpretations[index].provider.name;
      if (!failedSeen.has(name)) {
        failedSeen.add(name);
        failedUpstreams.push(name);
      }
      continue;
    }
    const { interpretation, resolved } = result.value;
    if (!resolved) continue;
    resolutions.push({ interpretation, provider: interpretation.provider, resolved });
  }

  // `onConflict: 'real-only'`: when both halves of a conflict group
  // resolved, drop the alias-rewrite half so the real-name match is the
  // only one downstream sees. When only the alias-rewrite half resolved
  // (the upstream has no model named after the alias itself), keep it —
  // the operator's intent is to fall back to the alias when no real model
  // collides.
  const droppedInterpretations = new Set<ModelInterpretation>();
  const byGroup = new Map<{ readonly originalLookupId: string }, ModelInterpretation[]>();
  for (const { interpretation } of resolutions) {
    const group = interpretation.conflictGroup;
    if (!group) continue;
    const list = byGroup.get(group) ?? [];
    list.push(interpretation);
    byGroup.set(group, list);
  }
  for (const members of byGroup.values()) {
    if (members.length < 2) continue;
    const aliasRewriteMember = members.find(i => i.aliasRules !== undefined);
    if (aliasRewriteMember) droppedInterpretations.add(aliasRewriteMember);
  }

  return {
    resolutions: resolutions.filter(r => !droppedInterpretations.has(r.interpretation)),
    failedUpstreams,
  };
};

export const resolveModelForRequest = async (
  modelId: string,
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[] = [],
): Promise<ModelResolution> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const interpretations = enumerateModelInterpretations(modelId, providers, aliases);
  const { resolutions, failedUpstreams } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);
  // Project each resolution's alias-rewrite interpretation onto the
  // returned ProviderModelResolution so passthrough callers can stamp the
  // `x-floway-alias` header without re-deriving the match.
  const matches: ProviderModelResolution[] = resolutions.map(r =>
    r.interpretation.aliasName !== undefined
      ? { ...r.resolved, aliasName: r.interpretation.aliasName }
      : r.resolved);
  return { matches, failedUpstreams };
};

export const resolveModelForProvider = async (
  instance: ModelProviderInstance,
  modelId: string,
  fetcher: Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelResolution | undefined> => {
  const providedModels = await fetchUpstreamModelsCached(instance, { scheduler, fetcher });
  const disabled = new Set(instance.disabledPublicModelIds);
  const exact = providedModels.find(model => model.id === modelId && !disabled.has(model.id));
  if (exact) return { id: exact.id, model: exact, binding: providerModelRecord(instance, exact) };

  const aliasTarget = instance.resolveRequestedModelId?.(modelId);
  if (!aliasTarget || aliasTarget === modelId) return undefined;

  const alias = providedModels.find(model => model.id === aliasTarget && !disabled.has(model.id));
  return alias ? { id: alias.id, model: alias, binding: providerModelRecord(instance, alias) } : undefined;
};
