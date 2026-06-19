-- Per-key dump metadata index. Applies on both runtimes; CF stores dumps in
-- its KeyDumpDO + R2 and never queries this table, so on Workers the table
-- exists but stays empty.
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  meta_json TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  PRIMARY KEY (key_id, id)
);
CREATE INDEX idx_dump_records_key_created ON dump_records (key_id, created_at DESC);
