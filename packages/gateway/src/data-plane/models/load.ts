import { synthesizeListedAliases } from './alias-listing.ts';
import type { ModelAliasesRepo } from '../../repo/types.ts';
import { getModels } from '../providers/registry.ts';
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
  if (model.chat) info.chat = model.chat;
  return info;
};

// Merge real-model entries with alias entries synthesized off the operator's
// alias catalog. An alias whose `name` collides with a real model id wins —
// two entries with the same `id` would break OpenAI client deduplication, and
// the alias was added by the operator deliberately, so collapsing to it
// preserves intent. `synthesizeListedAliases` already produces the alias entry;
// the merge step drops the real entry with that id.
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
  const aliasEntries = synthesizeListedAliases({ aliases, realModels });
  const aliasIds = new Set(aliasEntries.map(entry => entry.id));
  const data: PublicModel[] = [
    ...realModels.map(toPublicModel).filter(model => !aliasIds.has(model.id)),
    ...aliasEntries,
  ];
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
