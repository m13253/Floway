import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';
import { getInternalModels } from '../providers/registry.ts';
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

// Synthesize one PublicModel for each visible alias, appended after the real
// entries. The owner falls back to the alias-target's `owned_by` on whichever
// real entry resolves it; if the target isn't present on any reachable
// upstream, the entry still appears (operator-declared; the listing reflects
// operator intent) with a `floway` owner so the row is unambiguous.
export const toPublicModelFromAlias = (alias: ModelAlias, byId: ReadonlyMap<string, InternalModel>): PublicModel => {
  const target = byId.get(alias.targetModelId);
  const info: PublicModel = {
    id: alias.alias,
    object: 'model',
    type: 'model',
    display_name: alias.alias,
    limits: target?.limits ? { ...target.limits } : {},
    kind: target?.kind ?? 'chat',
    created: alias.createdAt,
    created_at: new Date(alias.createdAt * 1000).toISOString(),
    aliasedFrom: {
      targetModelId: alias.targetModelId,
      upstreamIds: alias.upstreamIds,
      rules: alias.rules,
      onConflict: alias.onConflict,
    },
  };
  info.owned_by = target?.owned_by ?? alias.upstreamIds[0] ?? 'floway';
  return info;
};

export const loadModels = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  aliases: readonly ModelAlias[],
): Promise<PublicModelsResponse> => {
  const internal = await getInternalModels(upstreamFilter, fetcherForUpstream, scheduler);
  const realEntries = internal.map(toPublicModel);
  const byId = new Map<string, InternalModel>(internal.map(m => [m.id, m]));
  // Visible aliases append in `loadAllAliases` order, after every real entry.
  // The spec's no-silent-hide policy keeps disabled-target aliases visible —
  // the user-facing failure on call is the canonical signal, not the
  // listing.
  const aliasEntries = aliases.filter(a => a.visibleInModelsList).map(a => toPublicModelFromAlias(a, byId));
  const data = [...realEntries, ...aliasEntries];
  return {
    object: 'list',
    has_more: false,
    first_id: data[0]?.id ?? null,
    last_id: data[data.length - 1]?.id ?? null,
    data,
  };
};
