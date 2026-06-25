import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import type { ModelProviderInstance, UpstreamModel } from '@floway-dev/provider';

// One emission slot for an alias: a (provider, addressable form) pair where
// the provider's raw catalog carries the alias target id, plus the matched
// UpstreamModel so the synthesized listing entry can borrow the target's
// limits, owner, and cost without re-querying.
export interface AliasListingEmission {
  provider: ModelProviderInstance;
  form: 'unprefixed' | 'prefixed';
  target: UpstreamModel;
}

// Per-upstream alias enumeration shared by `/v1/models` and the Gemini
// `/models` listings. An alias with empty `upstreamIds` matches every
// reachable provider; a non-empty list narrows the candidate set. Per
// provider, the alias emits one entry per `listed` form when its target sits
// in the upstream's raw catalog. Upstreams that do not carry the target — or
// whose operator disabled the target — drop the alias entirely for that row.
export const aliasListingEmissions = (
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

// The public id form an alias emission carries on the wire. Bare alias name
// for the unprefixed form; provider prefix + alias name for the prefixed
// form. Mirrors how real models are surfaced in the same listing pass.
export const aliasPublicId = (alias: ModelAlias, emission: AliasListingEmission): string => {
  const cfg = emission.provider.modelPrefix;
  return emission.form === 'prefixed' && cfg !== null ? `${cfg.prefix}${alias.alias}` : alias.alias;
};
