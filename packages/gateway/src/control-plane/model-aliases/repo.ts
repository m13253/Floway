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

const ALIAS_COLUMNS = 'alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, display_name, created_at';

// The model_aliases table is operator-managed and small (dozens of rows at
// most), so the data plane reads the full table per request — no cache layer.
// `ORDER BY alias` makes the read deterministic so `/v1/models` and friends
// emit alias entries in a stable, operator-predictable order across runtimes.
export const loadAllAliases = async (db: SqlDatabase): Promise<readonly ModelAlias[]> => {
  const { results } = await db
    .prepare(`SELECT ${ALIAS_COLUMNS} FROM model_aliases ORDER BY alias`)
    .all<ModelAliasRow>();
  return results.map(toModelAlias);
};

export const getAliasByName = async (db: SqlDatabase, alias: string): Promise<ModelAlias | null> => {
  const row = await db
    .prepare(`SELECT ${ALIAS_COLUMNS} FROM model_aliases WHERE alias = ?`)
    .bind(alias)
    .first<ModelAliasRow>();
  return row ? toModelAlias(row) : null;
};

// Detects PK collision with a SELECT round-trip rather than catching the
// INSERT throw — driver error shape differs between node:sqlite and D1.
export const insertAlias = async (db: SqlDatabase, alias: ModelAlias): Promise<{ ok: true } | { ok: false; reason: 'duplicate' }> => {
  const existing = await db
    .prepare('SELECT 1 FROM model_aliases WHERE alias = ?')
    .bind(alias.alias)
    .first<{ 1: number }>();
  if (existing) return { ok: false, reason: 'duplicate' };
  await db
    .prepare(`INSERT INTO model_aliases (${ALIAS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
    .bind(...bindValues(alias))
    .run();
  return { ok: true };
};

// UPSERT — on conflict the row is overwritten in place, but `created_at`
// is preserved (the row's first INSERT wins, matching how `proxies.save`
// keeps the original creation timestamp on a re-save).
export const saveAlias = async (db: SqlDatabase, alias: ModelAlias): Promise<void> => {
  await db
    .prepare(
      `INSERT INTO model_aliases (${ALIAS_COLUMNS}) VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (alias) DO UPDATE SET
         target_model_id = excluded.target_model_id,
         upstream_ids_json = excluded.upstream_ids_json,
         rules_json = excluded.rules_json,
         visible_in_models_list = excluded.visible_in_models_list,
         on_conflict = excluded.on_conflict,
         display_name = excluded.display_name,
         updated_at = unixepoch()`,
    )
    .bind(...bindValues(alias))
    .run();
};

export const deleteAlias = async (db: SqlDatabase, alias: string): Promise<{ deleted: boolean }> => {
  const result = await db.prepare('DELETE FROM model_aliases WHERE alias = ?').bind(alias).run();
  return { deleted: (result.meta.changes ?? 0) > 0 };
};

// Updates the PK column in place. A pre-flight SELECT detects the destination
// collision so the caller gets a structured `duplicate` reason instead of a
// driver-specific SQLITE_CONSTRAINT thrown error (shape differs between
// node:sqlite and D1). `meta.changes === 0` after the UPDATE means the source
// row was gone — propagated as `notFound` for the 404 mapping.
export const renameAlias = async (db: SqlDatabase, oldAlias: string, newAlias: string): Promise<{ ok: true } | { ok: false; reason: 'duplicate' | 'notFound' }> => {
  if (oldAlias === newAlias) return { ok: true };
  const conflict = await db
    .prepare('SELECT 1 FROM model_aliases WHERE alias = ?')
    .bind(newAlias)
    .first<{ 1: number }>();
  if (conflict) return { ok: false, reason: 'duplicate' };
  const result = await db
    .prepare('UPDATE model_aliases SET alias = ?, updated_at = unixepoch() WHERE alias = ?')
    .bind(newAlias, oldAlias)
    .run();
  if ((result.meta.changes ?? 0) === 0) return { ok: false, reason: 'notFound' };
  return { ok: true };
};

const bindValues = (alias: ModelAlias): unknown[] => [
  alias.alias,
  alias.targetModelId,
  JSON.stringify(alias.upstreamIds),
  JSON.stringify(alias.rules),
  alias.visibleInModelsList ? 1 : 0,
  alias.onConflict,
  alias.displayName ?? null,
  alias.createdAt,
];

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
