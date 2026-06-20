-- D1 table backing the per-key request dump feature. Same schema on both
-- runtimes — node:sqlite (Node deploy) and Cloudflare D1 (Worker deploy)
-- read and write through the same DumpStore contract.
--
-- The record bodies (request body, response body) live as separate files
-- in the FileProvider (R2 on Cloudflare, fs on Node). The DB row carries
-- only metadata + headers + per-side body descriptors that point at the
-- files. The split avoids JSON-in-blob base64 inflation and keeps bodies
-- out of the row so the DB stays small and fast to scan.
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,            -- ULID; lexically sortable, time-ordered
  created_at INTEGER NOT NULL, -- unix ms; mirrors meta_json.completedAt
  meta_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  response_headers_json TEXT,  -- NULL when no response was produced
  -- Each descriptor is either NULL (no body for that side) or
  -- {key, byteLength, contentType, type?} JSON. The response descriptor's
  -- `type` discriminates 'bytes' vs 'events'. The body files themselves
  -- are gzipped at rest in the FileProvider; the descriptor doesn't carry
  -- a hash because we don't deduplicate across keys.
  request_body_descriptor TEXT,
  response_body_descriptor TEXT,
  PRIMARY KEY (key_id, id)
);

-- The cron sweep filters by `(key_id, created_at < cutoff)` and the
-- dashboard list scans newest-first under one key, so a compound index
-- on (key_id, created_at DESC) drives both.
CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC);
