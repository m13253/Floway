ALTER TABLE model_aliases ADD COLUMN display_name TEXT;

UPDATE model_aliases SET display_name = 'Codex Auto Review'
  WHERE alias = 'codex-auto-review' AND display_name IS NULL;
