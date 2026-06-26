import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import { unionEndpoints } from '../providers/registry.ts';
import { composeAliasDisplayName, kindForEndpoints, type PublicModel } from '@floway-dev/protocols/common';
import type { ModelProviderInstance, ProviderModelRecord, ResolvedModel, UpstreamModel } from '@floway-dev/provider';

// One emission slot for an alias: a (provider, addressable form) pair where
// the provider's raw catalog carries the alias target id, plus the matched
// UpstreamModel so the synthesized listing entry can borrow the target's
// limits, owner, and cost without re-querying.
interface AliasListingEmission {
  provider: ModelProviderInstance;
  form: 'unprefixed' | 'prefixed';
  target: UpstreamModel;
}

// A `ResolvedModel` that may carry an `aliasedFrom` provenance — what
// `getModelsForListing` returns when alias entries have been interleaved into
// the catalog. Each listing endpoint's mapper (`toPublicModel`,
// `toControlPlaneModel`, `toGeminiModel`) reads the same shape, so the alias
// fan-out happens exactly once instead of being re-implemented per surface.
export type ListedModel = ResolvedModel & {
  readonly aliasedFrom?: NonNullable<PublicModel['aliasedFrom']>;
};

// Per-upstream alias enumeration. An alias with empty `upstreamIds` matches
// every reachable provider; a non-empty list narrows the candidate set. Per
// provider, the alias emits one entry per `listed` form when its target sits
// in the upstream's raw catalog. Upstreams that do not carry the target — or
// whose operator disabled the target — drop the alias entirely for that row.
const aliasListingEmissions = (
  alias: ModelAlias,
  providers: readonly ModelProviderInstance[],
  rawCatalogs: ReadonlyMap<string, readonly UpstreamModel[]>,
): AliasListingEmission[] => {
  const out: AliasListingEmission[] = [];
  const upstreamFilter = alias.upstreamIds.length > 0 ? new Set(alias.upstreamIds) : null;
  for (const provider of providers) {
    if (upstreamFilter !== null && !upstreamFilter.has(provider.upstream)) continue;
    const catalog = rawCatalogs.get(provider.upstream);
    if (catalog === undefined) continue;
    const disabled = new Set(provider.disabledPublicModelIds);
    const target = catalog.find(m => m.id === alias.targetModelId && !disabled.has(m.id));
    if (target === undefined) continue;
    const cfg = provider.modelPrefix;
    if (cfg === null) {
      out.push({ provider, form: 'unprefixed', target });
    } else {
      for (const form of cfg.listed) {
        out.push({ provider, form, target });
      }
    }
  }
  return out;
};

// Turn an alias emission into a `ListedModel` that walks the same listing
// pipeline as real catalog entries. The synthesized `providers` array carries
// a single binding pointing at the alias's target on this upstream, so the
// dashboard's per-binding view renders correctly without alias-specific
// branching. `aliasedFrom` rides out as the public protocol extension.
//
// Display name: the alias-local part (operator displayName, or
// `${target.display_name} (rules summary)`) lives by itself for the
// `unprefixed` listing form; the `prefixed` form mirrors the real-model path
// in `registry.ts` and prepends `${provider.name}: ` so the upstream is
// visible at a glance.
//
// Public id: bare alias name for the unprefixed form; provider prefix + alias
// name for the prefixed form. Mirrors how real models are surfaced in the
// same listing pass.
const aliasEmissionToListedModel = (alias: ModelAlias, emission: AliasListingEmission): ListedModel => {
  const { provider, target, form } = emission;
  const aliasLocalName = composeAliasDisplayName({
    aliasDisplayName: alias.displayName,
    targetDisplayName: target.display_name ?? target.id,
    rules: alias.rules,
  });
  const cfg = provider.modelPrefix;
  const publicId = form === 'prefixed' && cfg !== null ? `${cfg.prefix}${alias.alias}` : alias.alias;
  const record: ProviderModelRecord = {
    upstream: provider.upstream,
    upstreamName: provider.name,
    providerKind: provider.providerKind,
    provider: provider.provider,
    upstreamModel: target,
    enabledFlags: target.enabledFlags,
    supportsResponsesItemReference: provider.supportsResponsesItemReference,
  };
  const { providerData: _providerData, endpoints, id: _targetId, display_name: _targetDisplay, created: _targetCreated, ...rest } = target;
  return {
    ...rest,
    id: publicId,
    display_name: form === 'prefixed' ? `${provider.name}: ${aliasLocalName}` : aliasLocalName,
    created: alias.createdAt,
    endpoints: { ...endpoints },
    providers: [record],
    aliasedFrom: {
      targetModelId: alias.targetModelId,
      upstreamIds: alias.upstreamIds,
      rules: alias.rules,
      onConflict: alias.onConflict,
    },
  };
};

// Single-pass alias fan-out used by every listing surface. Visibility filter
// honoured here. Emissions whose synthesized public id collides — two
// no-prefix upstreams both serving the alias target, or two prefix-aliased
// upstreams sharing a prefix — merge into one row with the bindings
// appended, mirroring how `mergeIntoCatalog` collapses duplicate real-model
// ids; the dashboard then renders a single alias row whose `upstreams` lists
// every backing binding instead of N identical rows.
export const synthesizeListedAliases = (
  aliases: readonly ModelAlias[],
  providers: readonly ModelProviderInstance[],
  rawCatalogs: ReadonlyMap<string, readonly UpstreamModel[]>,
): ListedModel[] => {
  const byId = new Map<string, ListedModel>();
  for (const alias of aliases) {
    if (!alias.visibleInModelsList) continue;
    for (const emission of aliasListingEmissions(alias, providers, rawCatalogs)) {
      const next = aliasEmissionToListedModel(alias, emission);
      const existing = byId.get(next.id);
      if (existing === undefined) {
        byId.set(next.id, next);
        continue;
      }
      const endpoints = unionEndpoints(existing.endpoints, next.endpoints);
      byId.set(next.id, {
        ...existing,
        endpoints,
        kind: kindForEndpoints(endpoints),
        providers: [...existing.providers, ...next.providers],
      });
    }
  }
  return [...byId.values()];
};
