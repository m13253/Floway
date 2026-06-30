import { mergeAliasesIntoModels } from './alias-listing.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { enumerateAddressableModelIds, listedRealModels } from '../providers/addressable.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { Fetcher, InternalModel } from '@floway-dev/provider';

// Project an InternalModel onto the public-facing `/v1/models` wire DTO.
// `endpoints` rides through so listing clients can introspect each model's
// reach without a per-endpoint probe; alias entries surface the union of
// every currently-available target's reach (see `synthesizeListedAliases`).
export const toPublicModel = (model: InternalModel): PublicModel => {
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
  // Data-plane responses always narrow `aliasedFrom.targets` to the
  // caller's reachable set (and never expose typo'd / removed target
  // ids), but the alias's metadata is still computed gateway-wide so
  // every caller sees the same numbers.
  const [callerAddressable, gatewayAddressable, aliases] = await Promise.all([
    enumerateAddressableModelIds(upstreamFilter, fetcherForUpstream, scheduler),
    upstreamFilter === null
      ? Promise.resolve(null)
      : enumerateAddressableModelIds(null, fetcherForUpstream, scheduler),
    aliasRepo.list(),
  ]);
  const gatewayAddressableModelIds = gatewayAddressable ?? callerAddressable;
  const realModels = listedRealModels(callerAddressable);
  const data = mergeAliasesIntoModels({
    realModels,
    gatewayAddressableModelIds,
    callerAddressableModelIds: callerAddressable,
    aliases,
    narrowTargets: true,
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
