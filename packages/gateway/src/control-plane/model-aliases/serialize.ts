// Wire-format projection for the operator-managed model_aliases rows. The
// dashboard reads the same shape it sends back for create/update; the few
// snake_cased fields (`visible_in_models_list`, `on_conflict`, `created_at`,
// `display_name`) follow the rest of the control-plane HTTP surface.

import type { ModelAlias, ModelAliasRules, OnConflict } from './types.ts';

export interface SerializedModelAlias {
  alias: string;
  target_model_id: string;
  upstream_ids: string[];
  rules: ModelAliasRules;
  visible_in_models_list: boolean;
  on_conflict: OnConflict;
  display_name: string | null;
  created_at: number;
}

export const aliasToJson = (alias: ModelAlias): SerializedModelAlias => ({
  alias: alias.alias,
  target_model_id: alias.targetModelId,
  // Defensive copy: the readonly arrays inside ModelAlias are shared with
  // callers, and JSON serialization would otherwise expose the same backing
  // array used by `loadAll`.
  upstream_ids: [...alias.upstreamIds],
  rules: alias.rules,
  visible_in_models_list: alias.visibleInModelsList,
  on_conflict: alias.onConflict,
  display_name: alias.displayName ?? null,
  created_at: alias.createdAt,
});
