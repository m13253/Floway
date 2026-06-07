import type { Context } from 'hono';

import { backoffRowToJson, proxyRecordToJson } from './serialize.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { createProxyBody, resetBackoffBody, testProxyBody, updateProxyBody } from '../schemas.ts';
import { parseProxyUri, runProxiedRequest, type TargetSpec } from '@floway-dev/proxy';

const newId = (): string => `proxy_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;

const proxyUriValidationError = (err: unknown): string => `Invalid proxy URI: ${err instanceof Error ? err.message : String(err)}`;

export const listProxies = async (c: Context) => {
  const proxies = await getRepo().proxies.list();
  return c.json(proxies.map(proxyRecordToJson));
};

export const createProxy = async (c: CtxWithJson<typeof createProxyBody>) => {
  const body = c.req.valid('json');

  // The URI parser owns the full scheme matrix (http(s), socks5, ss, ss2022,
  // trojan, vless, reality); failing here surfaces the same message the
  // dashboard would otherwise see only on the first dial attempt.
  try {
    parseProxyUri(body.url);
  } catch (err) {
    return c.json({ error: proxyUriValidationError(err) }, 400);
  }

  const repo = getRepo();
  const existing = await repo.proxies.list();
  const sortOrder = existing.reduce((acc, p) => Math.max(acc, p.sortOrder), -1) + 1;
  const record = await repo.proxies.insert({
    id: newId(),
    name: body.name,
    url: body.url,
    sortOrder,
  });
  return c.json(proxyRecordToJson(record), 201);
};

export const updateProxy = async (c: CtxWithJson<typeof updateProxyBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');

  if (body.url !== undefined) {
    try {
      parseProxyUri(body.url);
    } catch (err) {
      return c.json({ error: proxyUriValidationError(err) }, 400);
    }
  }

  const record = await getRepo().proxies.patch(id, {
    name: body.name,
    url: body.url,
    sortOrder: body.sort_order,
  });
  if (!record) return c.json({ error: 'Proxy not found' }, 404);
  return c.json(proxyRecordToJson(record));
};

export const deleteProxy = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const repo = getRepo();

  // Refuse to orphan an upstream's `proxy_fallback_list`: the foreign-key
  // semantics are "remove the reference first, then drop the proxy". 409 with
  // the referencing upstream ids lets the dashboard offer a one-click
  // detach-and-retry instead of forcing the operator to hunt manually.
  const referencing = await repo.proxies.findUpstreamsReferencing(id);
  if (referencing.length > 0) {
    return c.json({ error: 'Proxy is referenced by upstreams', referencing_upstream_ids: referencing }, 409);
  }

  const ok = await repo.proxies.delete(id);
  if (!ok) return c.json({ error: 'Proxy not found' }, 404);

  // Sweep orphaned backoff rows. proxy_upstream_backoffs has no FK to proxies (see migration 0028), so the cleanup is unconditional.
  await repo.proxyBackoffs.resetForProxy(id);
  return c.body(null, 204);
};

// IP-echo anchors over HTTPS. ipify and AWS checkip return v4 by default
// (when the proxy egress carries a v4 route); 6.ident.me forces v6, useful
// when an operator wants to confirm a proxy actually has a v6 path.
const ANCHORS = {
  'ipify': { host: 'api.ipify.org', port: 443, path: '/' },
  'aws': { host: 'checkip.amazonaws.com', port: 443, path: '/' },
  'ident.me-v6': { host: '6.ident.me', port: 443, path: '/' },
} as const;

// IP-echo anchors return either an IPv4 in dot-notation or an IPv6 in mixed
// hex/colon (with an optional embedded IPv4 tail). Cap the response at 256
// chars before sniffing — a misbehaving anchor could otherwise feed an
// arbitrary HTML page into `last_egress_ip`. The regex is tight enough to
// reject anything obviously not an IP without trying to be a strict
// validator (we only need a "this looks plausible" gate).
const IP_LIKE_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F:]+)$/;

export const testProxy = async (c: CtxWithJson<typeof testProxyBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');
  const anchor = ANCHORS[body.anchor ?? 'ipify'];

  const repo = getRepo();
  const proxy = await repo.proxies.getById(id);
  if (!proxy) return c.json({ error: 'Proxy not found' }, 404);

  try {
    const config = parseProxyUri(proxy.url);
    const target: TargetSpec = {
      dialHost: anchor.host,
      port: anchor.port,
      tls: true,
      method: 'GET',
      path: anchor.path,
      headers: { 'Host': anchor.host, 'User-Agent': 'floway-proxy-test/1' },
    };
    const response = await runProxiedRequest(config, target);
    if (!response.ok) {
      return c.json({ ok: false, error: `Anchor returned status ${response.status}` });
    }
    const truncated = (await response.text()).slice(0, 256).trim();
    if (!IP_LIKE_RE.test(truncated)) {
      return c.json({ ok: false, error: `anchor returned non-IP body: ${truncated.slice(0, 80)}` });
    }
    await repo.proxies.recordTestSuccess(id, truncated);
    return c.json({ ok: true, egress_ip: truncated });
  } catch (err) {
    return c.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
  }
};

export const listAllBackoffs = async (c: Context) => {
  const rows = await getRepo().proxyBackoffs.listAll();
  return c.json(rows.map(backoffRowToJson));
};

export const listProxyBackoffs = async (c: Context) => {
  const id = c.req.param('id') ?? '';
  const rows = await getRepo().proxyBackoffs.listForProxy(id);
  return c.json(rows.map(backoffRowToJson));
};

export const resetProxyBackoffs = async (c: CtxWithJson<typeof resetBackoffBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');
  const repo = getRepo();

  if (body.upstream_id !== undefined) {
    await repo.proxyBackoffs.reset(id, body.upstream_id);
  } else {
    await repo.proxyBackoffs.resetForProxy(id);
  }
  return c.json({ ok: true });
};
