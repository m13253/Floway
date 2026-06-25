import type { ModelAlias, OnConflict } from './types.ts';
import type { SqlDatabase } from '@floway-dev/platform';

interface ModelAliasRow {
  alias: string;
  target_model_id: string;
  upstream_ids_json: string;
  rules_json: string;
  visible_in_models_list: number;
  on_conflict: OnConflict;
  display_name: string | null;
  created_at: number;
}

// The model_aliases table is operator-managed and small (dozens of rows at
// most), so the data plane reads the full table per request — no cache layer.
// `ORDER BY alias` makes the read deterministic so `/v1/models` and friends
// emit alias entries in a stable, operator-predictable order across runtimes.
export const loadAllAliases = async (db: SqlDatabase): Promise<readonly ModelAlias[]> => {
  const { results } = await db
    .prepare('SELECT alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, display_name, created_at FROM model_aliases ORDER BY alias')
    .all<ModelAliasRow>();
  return results.map(toModelAlias);
};

const toModelAlias = (row: ModelAliasRow): ModelAlias => ({
  alias: row.alias,
  targetModelId: row.target_model_id,
  upstreamIds: parseJsonField<string[]>(row.alias, 'upstream_ids_json', row.upstream_ids_json),
  rules: parseJsonField<ModelAlias['rules']>(row.alias, 'rules_json', row.rules_json),
  visibleInModelsList: row.visible_in_models_list === 1,
  onConflict: row.on_conflict,
  ...(row.display_name !== null ? { displayName: row.display_name } : {}),
  createdAt: row.created_at,
});

const parseJsonField = <T>(alias: string, field: string, raw: string): T => {
  try {
    return JSON.parse(raw) as T;
  } catch (cause) {
    throw new Error(`Malformed model_aliases ${field} for ${alias}`, { cause });
  }
};
