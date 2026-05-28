CREATE TABLE responses_items (
  id TEXT NOT NULL,
  api_key_id TEXT,
  upstream_id TEXT,
  upstream_item_id TEXT,
  item_type TEXT NOT NULL,
  payload_json TEXT,
  created_at INTEGER NOT NULL,
  CHECK (length(id) > 0),
  CHECK (length(item_type) > 0),
  CHECK (upstream_id IS NOT NULL OR upstream_item_id IS NULL)
);

CREATE UNIQUE INDEX idx_responses_items_id_scope ON responses_items (id, COALESCE(api_key_id, ''));
CREATE INDEX idx_responses_items_api_key_id ON responses_items (api_key_id);
CREATE INDEX idx_responses_items_created_at ON responses_items (created_at);
