-- Used by the Node deployment as a shared sqlite-backed metadata index.
-- The Cloudflare deployment never queries this table; KeyDumpDO keeps
-- per-DO storage instead.
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, id)
);
CREATE INDEX idx_dump_records_key_created ON dump_records (key_id, created_at DESC);
