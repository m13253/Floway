-- Extend the usage schema to model per-TTL cache writes and per-request
-- service tiers.
--
-- Two new concepts:
--   1. `input_cache_write_1h` — Anthropic's `extended-cache-ttl-2025-04-11`
--      beta surfaces 1-hour cache writes under
--      `usage.cache_creation.ephemeral_1h_input_tokens`. Until now we folded
--      both 5m and 1h writes into the same `input_cache_write` bucket, which
--      under-bills 1h writes (priced at input × 2 vs. input × 1.25 for 5m).
--      Add it as a new disjoint dimension; the CHECK list grows accordingly.
--   2. `tier` — Anthropic stamps `usage.speed: 'standard' | 'fast'` on
--      Opus 4.6+ and OpenAI stamps `usage.service_tier: 'default' | 'flex' |
--      'priority' | ...` on every chat/responses completion. Each value
--      selects a per-tier pricing override (see ModelPricing.tiers). The
--      tier is part of the bucket identity so a single model billed at
--      multiple tiers in one hour aggregates as separate buckets with
--      distinct unit prices.
--
-- Both tables (usage + usage_requests) get the new column. Existing rows
-- backfill with `tier = NULL`, which `resolveEffectivePricing` treats as
-- "base pricing", so historical aggregations compute identically to before.

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
