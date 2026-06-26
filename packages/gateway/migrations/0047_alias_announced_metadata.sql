-- Operator-set override for an alias's announced metadata payload — the
-- `limits` + `chat.*` block surfaced on /v1/models. NULL keeps the
-- automatic, rule-aware intersection across the alias's targets; a
-- non-null value is a JSON-encoded AnnouncedMetadata, sparse so any
-- omitted sub-field falls back to the automatic computation.
ALTER TABLE model_aliases ADD COLUMN announced_metadata_json TEXT;
