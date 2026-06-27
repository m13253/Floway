import { mergeAliasesIntoModels } from './alias-listing.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../providers/addressable.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { Fetcher, ResolvedModel } from '@floway-dev/provider';

export const toPublicModel = (model: ResolvedModel): PublicModel => {
  const info: PublicModel = {
    id: model.id,
    object: 'model',
    type: 'model',
    display_name: model.display_name ?? model.id,
    limits: { ...model.limits },
    kind: model.kind,
    endpoints: { ...model.endpoints },
  };
  if (model.owned_by !== undefined) info.owned_by = model.owned_by;
  if (model.created !== undefined) {
    info.created = model.created;
    info.created_at = new Date(model.created * 1000).toISOString();
  }
  if (model.cost) info.cost = model.cost;
  if (model.chat) info.chat = model.chat;
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliasRepo: ModelAliasesRepo,
): Promise<PublicModelsResponse> => {
  // The addressable surface already includes the listed projection — its
  // entries-where-unlisted-is-absent are exactly the rows /v1/models
  // historically served. Reusing the surface here avoids a second registry
  // call for the alias-availability check.
  const [addressable, aliases] = await Promise.all([
    enumerateAddressableModelIds(upstreamFilter, fetcherForUpstream, scheduler),
    aliasRepo.list(),
  ]);
  const realModels = listedRealModels(addressable);
  const data = mergeAliasesIntoModels({
    realModels,
    addressableModelIds: addressable,
    aliases,
    mapReal: toPublicModel,
    wrapAlias: entry => entry,
  });
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
