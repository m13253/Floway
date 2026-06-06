import { createUpstreamFetch } from './upstream-fetch.ts';
import { getRepo } from '../repo/index.ts';
import type { UpstreamFetch } from '@floway-dev/provider';
import { parseProxyUri, runProxiedRequest, type ProxyConfig } from '@floway-dev/proxy';

// Build a per-request mapper that hands each upstream id its own
// proxy-aware UpstreamFetch. The proxies catalog and the request's set of
// fallback lists are loaded eagerly once per data-plane call so each
// per-upstream fetcher can be constructed synchronously by id at the
// provider-factory boundary. Upstreams whose `proxyFallbackList` is empty
// receive a fetcher that walks the implicit ['direct'] list — i.e. plain
// runtime `fetch`, but still through the same instrumentation seam so a
// future global default proxy hook only has to land here.
export const createPerRequestFetcher = async (): Promise<(upstreamId: string) => UpstreamFetch> => {
  const repo = getRepo();
  const upstreams = await repo.upstreams.list();
  const fallbackById = new Map(upstreams.map(u => [u.id, u.proxyFallbackList] as const));

  const referencedProxyIds = new Set<string>();
  for (const list of fallbackById.values()) {
    for (const id of list) {
      if (id !== 'direct') referencedProxyIds.add(id);
    }
  }

  const proxyById = new Map<string, ProxyConfig>();
  if (referencedProxyIds.size > 0) {
    const proxies = await repo.proxies.list();
    for (const p of proxies) {
      if (!referencedProxyIds.has(p.id)) continue;
      try {
        proxyById.set(p.id, parseProxyUri(p.url));
      } catch (err) {
        // A single malformed URL must not poison every other upstream's
        // dial path. Skip the entry; createUpstreamFetch already throws
        // "unknown proxy id" for the affected upstream's fallback list,
        // which surfaces as a 502 only on requests that name this proxy.
        const message = err instanceof Error ? err.message : String(err);
        console.error(`proxy ${p.id}: skipping (malformed url): ${message}`);
      }
    }
  }

  return upstreamId => createUpstreamFetch({
    repo,
    upstreamId,
    fallbackList: fallbackById.get(upstreamId) ?? [],
    proxyById,
    runProxied: runProxiedRequest,
    runDirect: (url, init) => fetch(url, init),
  });
};
