-- Each entry in `proxy_fallback_list_json` becomes an object with a required
-- `id` (the proxy id or 'direct' sentinel) and an optional `colos` whitelist.
-- An empty / missing whitelist means "active in all colos"; a non-empty list
-- means "only attempt this entry when the data-plane request's current colo
-- is in the list". This makes the same fallback chain serve regions with
-- divergent proxy reachability or upstream-side geo restrictions.
--
-- The WHERE guard makes the rewrite idempotent: if every element of a row's
-- list is already an object (or the row is empty), we leave it alone. That
-- way a partial run that wrote some rows then crashed before the
-- migrations-table insert can be safely retried, and a node:sqlite
-- deployment re-baselining from a snapshot already in the new shape stays
-- safe.

UPDATE upstreams
SET proxy_fallback_list_json = COALESCE(
  (SELECT json_group_array(json_object('id', value))
   FROM json_each(proxy_fallback_list_json)),
  '[]'
)
WHERE EXISTS (
  SELECT 1 FROM json_each(proxy_fallback_list_json)
  WHERE json_type(value) = 'text'
);
