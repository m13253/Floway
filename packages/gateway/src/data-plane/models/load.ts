import { mergeAliasesIntoModels } from './alias-listing.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { getModels } from '../providers/registry.ts';
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
  const [realModels, aliases] = await Promise.all([
    getModels(upstreamFilter, fetcherForUpstream, scheduler),
    aliasRepo.list(),
  ]);
  const data = mergeAliasesIntoModels({
    realModels,
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
