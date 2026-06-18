-- Each entry in `proxy_fallback_list_json` becomes an object with a required
-- `id` (the proxy id or 'direct' sentinel) and an optional `colos` whitelist.
-- An empty / missing whitelist means "active in all colos"; a non-empty list
-- means "only attempt this entry when the data-plane request's current colo
-- is in the list". This makes the same fallback chain serve regions with
-- divergent proxy reachability or upstream-side geo restrictions.

UPDATE upstreams
SET proxy_fallback_list_json = COALESCE(
  (SELECT json_group_array(json_object('id', value))
   FROM json_each(proxy_fallback_list_json)),
  '[]'
);
