import { createFetcher, type ProxyEntry } from '../../dial/fetcher.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import { DIRECT_PROXY_ID, normalizeProxyFallbackList } from '../../repo/proxy-fallback-list.ts';
import { getSocketDial } from '@floway-dev/platform';
import { directFetcher, type Fetcher } from '@floway-dev/provider';
import { parseProxyUri, type ProxyUriError, runProxiedRequest } from '@floway-dev/proxy';

// One-shot fetcher resolution for control-plane operations that fire BEFORE
// or DURING an upstream edit, where the form's current proxy_fallback_list
// must take precedence over whatever is persisted. Three layered cases:
//
// 1. `override` present       → build a fetcher walking that list. Lets the
//                                operator's in-progress proxy edit reach the
//                                upstream even before the row is saved.
// 2. `override` absent, `upstreamId` present → reuse the per-request fetcher
//                                bound to the persisted row's fallback list,
//                                so a refresh-now click without any edit
//                                still uses the proxy chain the operator
//                                already configured.
// 3. neither present          → `directFetcher`. Same shape as the prior
//                                bootstrap-only direct egress used during
//                                import.
//
// The override path validates proxy ids against the catalog and surfaces a
// parse / unknown-id error as a thrown rejection at call time, mirroring
// `createPerRequestFetcher`'s isolation policy: a single bad row must not
// take down the call.
export const resolveControlPlaneFetcher = async (opts: {
  override?: readonly string[];
  upstreamId?: string;
}): Promise<Fetcher> => {
  if (opts.override !== undefined) {
    return await buildOverrideFetcher(opts.override, opts.upstreamId ?? 'draft');
  }
  if (opts.upstreamId !== undefined) {
    return await buildPersistedFetcher(opts.upstreamId);
  }
  return directFetcher;
};

const buildOverrideFetcher = async (rawList: readonly string[], upstreamId: string): Promise<Fetcher> => {
  const list = normalizeProxyFallbackList(rawList);
  const referenced = new Set(list.filter(id => id !== DIRECT_PROXY_ID));
  if (referenced.size === 0) {
    return directFetcher;
  }

  const repo = getRepo();
  const proxies = await repo.proxies.list();
  const proxyById = new Map<string, ProxyEntry>();
  const parseErrors = new Map<string, ProxyUriError>();
  for (const p of proxies) {
    if (!referenced.has(p.id)) continue;
    try {
      proxyById.set(p.id, {
        config: parseProxyUri(p.url),
        dialTimeoutMs: p.dialTimeoutSeconds === null ? null : p.dialTimeoutSeconds * 1000,
      });
    } catch (err) {
      parseErrors.set(p.id, err as ProxyUriError);
    }
  }

  const unknown = list.find(id => id !== DIRECT_PROXY_ID && !proxyById.has(id) && !parseErrors.has(id));
  if (unknown !== undefined) {
    throw new Error(`unknown proxy id in fallback list: ${unknown}`);
  }
  const bad = list.find(id => parseErrors.has(id));
  if (bad !== undefined) {
    const err = parseErrors.get(bad)!;
    throw new Error(`malformed proxy ${bad}: ${err.message}`);
  }

  return createFetcher({
    repo,
    upstreamId,
    fallbackList: list,
    proxyById,
    runProxied: runProxiedRequest,
    runDirect: directFetcher,
    socketDial: getSocketDial,
  });
};

const buildPersistedFetcher = async (upstreamId: string): Promise<Fetcher> => {
  const fetcherFor = await createPerRequestFetcher();
  return fetcherFor(upstreamId);
};
