import { aliasListingEmissions, aliasPublicId, type AliasListingEmission } from './alias-listing.ts';
import { composeAliasDisplayName } from '../../control-plane/model-aliases/display.ts';
import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import { getModelsForListing } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { Fetcher, InternalModel } from '@floway-dev/provider';

export const toPublicModel = (model: InternalModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
  };
  if (model.owned_by !== undefined) info.owned_by = model.owned_by;
  if (model.created !== undefined) {
    info.created = model.created;
    info.created_at = new Date(model.created * 1000).toISOString();
  }
  if (model.cost) info.cost = model.cost;
  return info;
};

const publicModelForAliasEmission = (alias: ModelAlias, emission: AliasListingEmission): PublicModel => {
  const { provider, target } = emission;
  const targetDisplayName = target.display_name ?? target.id;
  const info: PublicModel = {
    id: aliasPublicId(alias, emission),
    object: 'model',
    type: 'model',
    display_name: composeAliasDisplayName({
      upstreamDisplayName: provider.name,
      aliasDisplayName: alias.displayName,
      targetDisplayName,
      rules: alias.rules,
    }),
    limits: target.limits ? { ...target.limits } : {},
    kind: target.kind,
    created: alias.createdAt,
    created_at: new Date(alias.createdAt * 1000).toISOString(),
    aliasedFrom: {
      targetModelId: alias.targetModelId,
      upstreamIds: alias.upstreamIds,
      rules: alias.rules,
      onConflict: alias.onConflict,
    },
  };
  info.owned_by = target.owned_by ?? provider.upstream;
  if (target.cost) info.cost = target.cost;
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[],
): Promise<PublicModelsResponse> => {
  const { models, providers, rawCatalogs } = await getModelsForListing(upstreamFilter, fetcherForUpstream, scheduler);
  const realEntries = models.map(toPublicModel);
  // Per-upstream alias enumeration: for each visible alias, emit one entry per
  // (provider, addressable form) pair where the provider can resolve the
  // alias's target. Upstreams that do not carry the target produce no entry —
  // the alias listing is strictly anchored to "can be served from here".
  const aliasEntries: PublicModel[] = [];
  for (const alias of aliases) {
    if (!alias.visibleInModelsList) continue;
    for (const emission of aliasListingEmissions(alias, providers, rawCatalogs)) {
      aliasEntries.push(publicModelForAliasEmission(alias, emission));
    }
  }
  const data = [...realEntries, ...aliasEntries];
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
