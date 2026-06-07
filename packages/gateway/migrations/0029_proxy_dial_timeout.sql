-- Per-proxy dial timeout. Override for the global DIAL_DEADLINE_MS in
-- @floway-dev/proxy. NULL means "use the gateway default" so an existing
-- catalog continues to behave the same after the migration.
ALTER TABLE proxies ADD COLUMN dial_timeout_seconds INTEGER NULL;
