-- Adds the proxies catalog, the per-(proxy, upstream) backoff table, and
-- the per-upstream proxy fallback list column.

CREATE TABLE proxies (
  id              TEXT PRIMARY KEY,
  name            TEXT NOT NULL,
  url             TEXT NOT NULL,
  sort_order      INTEGER NOT NULL DEFAULT 0,
  created_at      TEXT NOT NULL,
  updated_at      TEXT NOT NULL,
  last_egress_ip  TEXT,
  last_tested_at  INTEGER
);
CREATE INDEX idx_proxies_sort_order ON proxies (sort_order, created_at);

-- proxy_id is either a proxies.id OR the literal string 'direct'. We do
-- not foreign-key it: 'direct' has no row, and proxy DELETE is gated by a
-- reference check at the API layer.
CREATE TABLE proxy_upstream_backoffs (
  proxy_id      TEXT NOT NULL,
  upstream_id   TEXT NOT NULL,
  fail_count    INTEGER NOT NULL DEFAULT 0,
  expires_at    INTEGER NOT NULL,
  last_error    TEXT,
  last_error_at INTEGER,
  PRIMARY KEY (proxy_id, upstream_id)
);
-- The (proxy_id, upstream_id) PK already covers every read (always keyed
-- by one of the two id columns); no scheduled GC sweeps the table by
-- expires_at, so an additional index would be dead weight.

ALTER TABLE upstreams
  ADD COLUMN proxy_fallback_list_json TEXT NOT NULL DEFAULT '[]';
