// Wire-format projection for proxy and backoff repo records. Snake-case keys
// match the rest of the control-plane API surface; the repo-side types stay
// camelCase. Proxy URLs are returned verbatim — the URI itself carries the
// secret material (password / shadowsocks key) and the dashboard needs the
// canonical form to render a "copy" affordance and re-edit existing rows.

import type { BackoffRow, ProxyRecord } from '../../repo/types.ts';

export interface SerializedProxyRecord {
  id: string;
  name: string;
  url: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  last_egress_ip: string | null;
  last_tested_at: number | null;
}

export interface SerializedBackoffRow {
  proxy_id: string;
  upstream_id: string;
  fail_count: number;
  expires_at: number;
  last_error: string | null;
  last_error_at: number | null;
}

export const proxyRecordToJson = (record: ProxyRecord): SerializedProxyRecord => ({
  id: record.id,
  name: record.name,
  url: record.url,
  sort_order: record.sortOrder,
  created_at: record.createdAt,
  updated_at: record.updatedAt,
  last_egress_ip: record.lastEgressIp,
  last_tested_at: record.lastTestedAt,
});

export const backoffRowToJson = (row: BackoffRow): SerializedBackoffRow => ({
  proxy_id: row.proxyId,
  upstream_id: row.upstreamId,
  fail_count: row.failCount,
  expires_at: row.expiresAt,
  last_error: row.lastError,
  last_error_at: row.lastErrorAt,
});
