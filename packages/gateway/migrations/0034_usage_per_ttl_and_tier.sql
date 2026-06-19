-- Add `tier` (Anthropic `usage.speed`, OpenAI `usage.service_tier`) to usage
-- and usage_requests, and `input_cache_write_1h` to the dimension CHECK list.
-- Existing rows backfill with `tier = NULL` so historical aggregations compute
-- identically. SQLite cannot extend a CHECK constraint or a UNIQUE INDEX in
-- place over a new column, so both tables are rebuilt.

CREATE TABLE usage_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  dimension TEXT NOT NULL CHECK (dimension IN (
    'input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'
  )),
  tokens INTEGER NOT NULL DEFAULT 0,
  unit_price REAL
);

INSERT INTO usage_new (key_id, model, upstream, model_key, hour, tier, dimension, tokens, unit_price)
  SELECT key_id, model, upstream, model_key, hour, NULL, dimension, tokens, unit_price FROM usage;

DROP TABLE usage;
ALTER TABLE usage_new RENAME TO usage;

CREATE UNIQUE INDEX idx_usage_dimension_identity
  ON usage (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''), dimension);
CREATE INDEX idx_usage_dimension_hour ON usage (hour);

CREATE TABLE usage_requests_new (
  key_id TEXT NOT NULL,
  model TEXT NOT NULL,
  upstream TEXT,
  model_key TEXT NOT NULL,
  hour TEXT NOT NULL,
  tier TEXT,
  requests INTEGER NOT NULL DEFAULT 0
);

INSERT INTO usage_requests_new (key_id, model, upstream, model_key, hour, tier, requests)
  SELECT key_id, model, upstream, model_key, hour, NULL, requests FROM usage_requests;

DROP TABLE usage_requests;
ALTER TABLE usage_requests_new RENAME TO usage_requests;

CREATE UNIQUE INDEX idx_usage_requests_identity
  ON usage_requests (key_id, model, COALESCE(upstream, ''), model_key, hour, COALESCE(tier, ''));
CREATE INDEX idx_usage_requests_hour ON usage_requests (hour);
