import { fetchUpstreamModelsCached } from './models-cache.ts';
import { getRepo } from '../../repo/index.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import { type ModelEndpointKey, type ModelEndpoints, kindForEndpoints } from '@floway-dev/protocols/common';
import type { CatalogModel, Fetcher, Provider, UpstreamModel, UpstreamProviderKind, UpstreamRecord } from '@floway-dev/provider';
import { createAzureProvider } from '@floway-dev/provider-azure';
import { createClaudeCodeProvider } from '@floway-dev/provider-claude-code';
import { createCodexProvider } from '@floway-dev/provider-codex';
import { createCopilotProvider } from '@floway-dev/provider-copilot';
import { createCustomProvider } from '@floway-dev/provider-custom';
import { createOllamaProvider } from '@floway-dev/provider-ollama';

interface ProviderModelsResult {
  models: CatalogModel[];
  // Reverse index: every upstream instance that emitted an entry under the
  // given public id, in enumeration order. The control-plane catalog
  // endpoint reads this to render `upstreams: [{kind, id, name}]` per row.
  upstreamsByPublicId: Map<string, Provider[]>;
  sawSuccess: boolean;
  lastError: unknown;
  // Upstream names whose catalog fetch rejected this round, in the same
  // order as the input `providers` list so the model-missing renderer can
  // surface a stable, dashboard-aligned list.
  failedUpstreams: string[];
}

const NO_UPSTREAM_CONFIGURED_MESSAGE = 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard';

type ProviderFactory = (record: UpstreamRecord) => Provider | Promise<Provider>;

const providerFactories: Record<UpstreamProviderKind, ProviderFactory> = {
  copilot: createCopilotProvider,
  custom: createCustomProvider,
  azure: createAzureProvider,
  codex: createCodexProvider,
  'claude-code': createClaudeCodeProvider,
  ollama: createOllamaProvider,
};

export const createProviderInstance = (record: UpstreamRecord): Provider | Promise<Provider> =>
  providerFactories[record.kind](record);

// The upstream scope is a required argument across the catalog-assembly chain
// (this, getModels) so a caller can never omit it and silently receive the
// full, unscoped catalog — a missing scope is a compile error, not a runtime
// leak. Pass `null` to deliberately request every enabled upstream.
export const listModelProviders = async (
  upstreamFilter: readonly string[] | null,
): Promise<Provider[]> => {
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

  const providers: Provider[] = [];
  for (const upstream of selection) {
    const factory = providerFactories[upstream.kind];
    providers.push(await factory(upstream));
  }

  return providers;
};

// Merge two capability maps: a key present in either side is present in the
// result, and its sub-capability flags are OR-ed so a sub-cap advertised by
// either provider survives.
const unionEndpoints = (a: ModelEndpoints, b: ModelEndpoints): ModelEndpoints => {
  const result: ModelEndpoints = { ...a };
  for (const key of Object.keys(b) as ModelEndpointKey[]) {
    const merged = { ...result[key], ...b[key] };
    (result as Record<ModelEndpointKey, object>)[key] = merged;
  }
  return result;
};

const catalogFromUpstreamModel = (upstreamModel: UpstreamModel): CatalogModel => {
  const { providerData: _providerData, endpoints, ...internal } = upstreamModel;
  return { ...internal, endpoints: { ...endpoints } };
};

// When multiple upstreams expose the same public model id, the first wins
// for /models metadata and later ones union-merge their endpoint capability
// flags. Runtime execution still uses each provider's own UpstreamModel, so
// capability-sensitive calls do not depend on this merged view. The reverse
// index `upstreamsByPublicId` accumulates every upstream that surfaced the
// id, in enumeration order, so the control plane can render its per-model
// upstream chips without re-walking the catalog.
const mergeIntoCatalog = (
  byId: Map<string, CatalogModel>,
  upstreamsByPublicId: Map<string, Provider[]>,
  instance: Provider,
  surfacedModel: UpstreamModel,
  publicId: string,
): void => {
  const existing = byId.get(publicId);
  if (!existing) {
    byId.set(publicId, catalogFromUpstreamModel(surfacedModel));
    upstreamsByPublicId.set(publicId, [instance]);
    return;
  }
  const endpoints = unionEndpoints(existing.endpoints, surfacedModel.endpoints);
  byId.set(publicId, {
    ...existing,
    endpoints,
    kind: kindForEndpoints(endpoints),
  });
  upstreamsByPublicId.get(publicId)?.push(instance);
};

const collectProviderModels = async (
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ProviderModelsResult> => {
  const byId = new Map<string, CatalogModel>();
  const upstreamsByPublicId = new Map<string, Provider[]>();
  let sawSuccess = false;
  let lastError: unknown = null;
  const failedUpstreams: string[] = [];

  // Fan out per-upstream so a slow provider does not stall the rest. The SWR
  // cache layer dedupes concurrent in-flight fetches per upstream and serves
  // the SOFT-fresh row without an upstream round trip, so the parallel walk
  // is cheap on the warm path and bounded by `max(per-upstream fetch)` on
  // the cold path.
  const fetchOne = (instance: Provider) =>
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
          mergeIntoCatalog(byId, upstreamsByPublicId, instance, surfacedModel, publicId);
        }
      } else {
        mergeIntoCatalog(byId, upstreamsByPublicId, instance, upstreamModel, upstreamModel.id);
      }
    }
  }

  return { models: [...byId.values()], upstreamsByPublicId, sawSuccess, lastError, failedUpstreams };
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
// per-upstream proxy chain. Returns the merged catalog together with the
// reverse `upstreamsByPublicId` map; callers that only want the bare
// metadata projection (`/v1/models`, `/models`, etc.) destructure
// `models` and ignore the map.
export const getModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{ models: CatalogModel[]; upstreamsByPublicId: Map<string, Provider[]> }> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) {
    throw new Error(NO_UPSTREAM_CONFIGURED_MESSAGE);
  }

  const { models, upstreamsByPublicId, sawSuccess, lastError } = await collectProviderModels(providers, fetcherForUpstream, scheduler);

  if (sawSuccess) return { models: models.sort((a, b) => compareModelIds(a.id, b.id)), upstreamsByPublicId };
  if (lastError) throw lastError;
  return { models: [], upstreamsByPublicId };
};

// A single (provider, upstream-catalog model) pair the resolver matched
// against an inbound id. `id` is the upstream's bare catalog id (which
// equals `model.id` and differs from the inbound id when the inbound
// matched the prefixed surface); telemetry and dump records key on that
// canonical id while error envelopes echo the inbound `model` instead.
export interface ModelResolution {
  id: string;
  model: UpstreamModel;
  provider: Provider;
}

export interface ModelInterpretation {
  provider: Provider;
  // The bare id to query the upstream's catalog with. Equals the inbound
  // model id for the unprefixed surface; equals `inbound.slice(prefix.length)`
  // for the prefixed surface.
  lookupId: string;
}

// Expands one inbound model id into every (provider, catalog-lookup-id) pair
// the upstream registry can interpret it as. A request matches an upstream
// when the inbound id literally equals one of the public-id surfaces the
// upstream advertises (bare and/or prefixed, per `modelPrefix.addressable`).
// The unprefixed interpretation is always pushed first when both apply.
export const enumerateModelInterpretations = (
  modelId: string,
  providers: readonly Provider[],
): ModelInterpretation[] => {
  const out: ModelInterpretation[] = [];
  for (const provider of providers) {
    const cfg = provider.modelPrefix;
    if (cfg === null || cfg.addressable.includes('unprefixed')) {
      out.push({ provider, lookupId: modelId });
    }
    if (cfg !== null && cfg.addressable.includes('prefixed') && modelId.startsWith(cfg.prefix)) {
      out.push({ provider, lookupId: modelId.slice(cfg.prefix.length) });
    }
  }
  return out;
};

// Fan out per-interpretation against the SWR cache and collect the resolved
// matches plus a deduped list of upstreams whose catalog fetch rejected.
// Cancellation (`AbortError`) propagates so the per-request abort signal
// cannot be masked by a slow upstream's rejection.
export const collectInterpretationOutcomes = async (
  interpretations: readonly ModelInterpretation[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  resolutions: ModelResolution[];
  failedUpstreams: string[];
}> => {
  const settled = await Promise.allSettled(interpretations.map(({ provider, lookupId }) =>
    findModelInProvider(provider, lookupId, fetcherForUpstream(provider.upstream), scheduler)));

  const failedUpstreams: string[] = [];
  const failedSeen = new Set<string>();
  const resolutions: ModelResolution[] = [];

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
    if (result.value !== undefined) resolutions.push(result.value);
  }

  return { resolutions, failedUpstreams };
};

// Eight-digit dated suffix on the inbound id — a vendor-pin shape some
// clients use. When the first resolution misses, the resolver strips
// the suffix and retries once. See RESOLUTION.md.
const DATED_SUFFIX = /-\d{8}$/;

export const resolveInterpretationsAcrossProviders = async (
  modelId: string,
  providers: readonly Provider[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<{
  readonly resolutions: readonly ModelResolution[];
  readonly failedUpstreams: readonly string[];
}> => {
  const first = await collectInterpretationOutcomes(
    enumerateModelInterpretations(modelId, providers),
    fetcherForUpstream,
    scheduler,
  );
  if (first.resolutions.length > 0 || !DATED_SUFFIX.test(modelId)) return first;

  const stripped = modelId.replace(DATED_SUFFIX, '');
  const second = await collectInterpretationOutcomes(
    enumerateModelInterpretations(stripped, providers),
    fetcherForUpstream,
    scheduler,
  );
  return {
    resolutions: second.resolutions,
    failedUpstreams: [...new Set([...first.failedUpstreams, ...second.failedUpstreams])],
  };
};

export const findModelInProvider = async (
  instance: Provider,
  modelId: string,
  fetcher: Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ModelResolution | undefined> => {
  const providedModels = await fetchUpstreamModelsCached(instance, { scheduler, fetcher });
  const disabled = new Set(instance.disabledPublicModelIds);
  const exact = providedModels.find(model => model.id === modelId && !disabled.has(model.id));
  return exact ? { id: exact.id, model: exact, provider: instance } : undefined;
};
