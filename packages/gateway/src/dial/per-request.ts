import { createFetcher, type ProxyEntry } from './fetcher.ts';
import { getRepo } from '../repo/index.ts';
import type { Fetcher } from '@floway-dev/provider';
import { directFetcher } from '@floway-dev/provider';
import { parseProxyUri, runProxiedRequest } from '@floway-dev/proxy';

// Build a per-request mapper that hands each upstream id its own
// proxy-aware Fetcher. The proxies catalog and the request's set of
// fallback lists are loaded eagerly once per data-plane call so each
// per-upstream fetcher can be constructed synchronously by id at the
// provider-factory boundary. Upstreams whose `proxyFallbackList` is empty
// receive a fetcher that walks the implicit ['direct'] list — i.e. plain
// runtime `fetch`, but still through the same instrumentation seam so a
// future global default proxy hook only has to land here.
export const createPerRequestFetcher = async (): Promise<(upstreamId: string) => Fetcher> => {
  const repo = getRepo();
  const upstreams = await repo.upstreams.list();
  const fallbackById = new Map(upstreams.map(u => [u.id, u.proxyFallbackList] as const));

  const referencedProxyIds = new Set<string>();
  for (const list of fallbackById.values()) {
    for (const id of list) {
      if (id !== 'direct') referencedProxyIds.add(id);
    }
  }

  const proxyById = new Map<string, ProxyEntry>();
  if (referencedProxyIds.size > 0) {
    const proxies = await repo.proxies.list();
    for (const p of proxies) {
      if (!referencedProxyIds.has(p.id)) continue;
      proxyById.set(p.id, {
        config: parseProxyUri(p.url),
        // Carry the per-proxy timeout (seconds → ms) so the dial layer can
        // honour an operator's override; null preserves the gateway default
        // baked into @floway-dev/proxy.
        dialTimeoutMs: p.dialTimeoutSeconds === null ? null : p.dialTimeoutSeconds * 1000,
      });
    }
  }

  return upstreamId => createFetcher({
    repo,
    upstreamId,
    fallbackList: fallbackById.get(upstreamId) ?? [],
    proxyById,
    runProxied: runProxiedRequest,
    runDirect: directFetcher,
  });
};
