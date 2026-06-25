CREATE TABLE model_aliases (
  alias TEXT PRIMARY KEY,
  target_model_id TEXT NOT NULL,
  upstream_ids_json TEXT NOT NULL DEFAULT '[]',
  rules_json TEXT NOT NULL DEFAULT '{}',
  visible_in_models_list INTEGER NOT NULL DEFAULT 1,
  on_conflict TEXT NOT NULL DEFAULT 'real-only'
    CHECK (on_conflict IN ('alias-only', 'real-only', 'both-real-first', 'both-alias-first')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

INSERT OR IGNORE INTO model_aliases (alias, target_model_id, rules_json, on_conflict)
VALUES ('codex-auto-review', 'gpt-5.4', '{"reasoning":{"effort":"low"}}', 'real-only');
