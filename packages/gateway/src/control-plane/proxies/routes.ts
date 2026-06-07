import type { Context } from 'hono';

import { backoffRowToJson, proxyRecordToJson } from './serialize.ts';
import { type CtxWithJson } from '../../middleware/zod-validator.ts';
import { getRepo } from '../../repo/index.ts';
import type { createProxyBody, resetBackoffBody, testProxyBody, updateProxyBody } from '../schemas.ts';
import { parseProxyUri, runProxiedRequest, type ProxyConfig, type TargetSpec } from '@floway-dev/proxy';

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
    dialTimeoutSeconds: body.dial_timeout_seconds ?? null,
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

  const repo = getRepo();
  // Capture the existing URL before patch so we know whether to sweep
  // backoff state — the patch itself only signals URL change via clearing
  // the test-result fields, which would otherwise leave operators waiting
  // for the geometric schedule to recover after they fixed a broken proxy.
  const existing = await repo.proxies.getById(id);
  if (!existing) return c.json({ error: 'Proxy not found' }, 404);
  const urlChanged = body.url !== undefined && body.url !== existing.url;

  const record = await repo.proxies.patch(id, {
    name: body.name,
    url: body.url,
    sortOrder: body.sort_order,
    // Forward the absent / null distinction so the repo can tell "leave it"
    // from "clear it back to default" — Object.hasOwn carries the bit
    // through the spread below.
    ...(Object.hasOwn(body, 'dial_timeout_seconds') ? { dialTimeoutSeconds: body.dial_timeout_seconds ?? null } : {}),
  });
  if (!record) return c.json({ error: 'Proxy not found' }, 404);

  if (urlChanged) {
    // The new URL might point at a healthy server; the old URL's backoff
    // state must not stop the dial layer from retrying immediately.
    await repo.proxyBackoffs.resetForProxy(id);
  }

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

  // The DELETE predicate re-checks referencing in the same statement to
  // close the TOCTOU window between the read above and the write — a
  // concurrent admin PATCH that adds a reference now blocks the delete
  // atomically. If 0 rows changed, distinguish "raced into 409" from
  // "really not found" by re-reading the reference list.
  const ok = await repo.proxies.delete(id);
  if (!ok) {
    const racedRefs = await repo.proxies.findUpstreamsReferencing(id);
    if (racedRefs.length > 0) {
      return c.json({ error: 'Proxy is referenced by upstreams', referencing_upstream_ids: racedRefs }, 409);
    }
    return c.json({ error: 'Proxy not found' }, 404);
  }

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
// arbitrary HTML page into `last_egress_ip`. The regex tightens each
// branch enough to reject obvious junk: octets are 1-3 digits, the v6
// branch requires at least one colon so an `aaaa`-style hex blob can't
// masquerade as an IP. We don't claim octet-range validity here; that's
// what the dashboard's display logic can do later.
const IP_LIKE_RE = /^(?:\d{1,3}(?:\.\d{1,3}){3}|[0-9a-fA-F]*:[0-9a-fA-F:.]*[0-9a-fA-F])$/;

export const testProxy = async (c: CtxWithJson<typeof testProxyBody>) => {
  const id = c.req.param('id') ?? '';
  const body = c.req.valid('json');
  const anchor = ANCHORS[body.anchor ?? 'ipify'];

  const repo = getRepo();
  const proxy = await repo.proxies.getById(id);
  if (!proxy) return c.json({ error: 'Proxy not found' }, 404);

  // Stored-data validation: a row whose URL no longer parses is operator-
  // actionable D1 drift, not a transient dial failure. 400 surfaces it as
  // a config problem so the dashboard can prompt the operator to fix the
  // row instead of styling it as a network error.
  let config: ProxyConfig;
  try {
    config = parseProxyUri(proxy.url);
  } catch (err) {
    return c.json({ error: proxyUriValidationError(err) }, 400);
  }

  try {
    const target: TargetSpec = {
      dialHost: anchor.host,
      port: anchor.port,
      tls: true,
      method: 'GET',
      path: anchor.path,
      headers: { 'Host': anchor.host, 'User-Agent': 'floway-proxy-test/1' },
    };
    const response = await runProxiedRequest(
      config,
      target,
      proxy.dialTimeoutSeconds === null ? undefined : { dialTimeoutMs: proxy.dialTimeoutSeconds * 1000 },
    );
    if (!response.ok) {
      return c.json({ ok: false, error: `Anchor returned status ${response.status}` });
    }
    const truncated = (await response.text()).slice(0, 256).trim();
    if (!IP_LIKE_RE.test(truncated)) {
      return c.json({ ok: false, error: `anchor returned non-IP body: ${truncated.slice(0, 80)}` });
    }
    // The v6 anchor exists specifically to confirm an operator has a v6
    // egress path. 6.ident.me has both A and AAAA records, so a v4-only
    // proxy still gets a routable answer — but reporting that v4 back as
    // a "v6" check would silently mislead. Reject the v4 shape on the v6
    // anchor explicitly.
    if ((body.anchor ?? 'ipify') === 'ident.me-v6' && !truncated.includes(':')) {
      return c.json({ ok: false, error: `v6 anchor returned a v4 address (${truncated}); proxy has no v6 path` });
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
