import type { ListedModel } from './alias-listing.ts';
import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import { getModelsForListing } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { PublicModel, PublicModelsResponse } from '@floway-dev/protocols/common';
import type { Fetcher, InternalModel } from '@floway-dev/provider';

// Maps a single listed catalog entry (real or alias) to the wire DTO. Alias
// entries arrive with `aliasedFrom` pre-populated by
// `synthesizeListedAliases`; this mapper just rides it through so every
// listing surface sees the same provenance field.
export const toPublicModel = (model: InternalModel & { aliasedFrom?: ListedModel['aliasedFrom'] }): PublicModel => {
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
  if (model.aliasedFrom) info.aliasedFrom = model.aliasedFrom;
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[],
): Promise<PublicModelsResponse> => {
  const { models } = await getModelsForListing(upstreamFilter, fetcherForUpstream, scheduler, aliases);
  const data = models.map(toPublicModel);
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
