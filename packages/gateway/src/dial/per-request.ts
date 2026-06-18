import { createFetcher, type ProxyEntry } from './fetcher.ts';
import { getRepo } from '../repo/index.ts';
import { DIRECT_PROXY_ID } from '../repo/proxy-fallback-list.ts';
import { getSocketDial } from '@floway-dev/platform';
import { directFetcher, type Fetcher } from '@floway-dev/provider';
import { parseProxyUri, type ProxyUriError, runProxiedRequest } from '@floway-dev/proxy';

// Build a per-request mapper that hands each upstream id its own
// proxy-aware Fetcher. The proxies catalog and the request's set of
// fallback lists are loaded eagerly once per data-plane call so each
// per-upstream fetcher can be constructed synchronously by id. Upstreams
// whose `proxyFallbackList` is empty receive a fetcher that walks the
// implicit ['direct'] list — i.e. plain runtime `fetch`.
//
// `currentColo` (resolved once per request by the caller, typically from
// `GatewayCtx`) is threaded into every fetcher so per-entry `colos`
// whitelists can be honoured at dial time.
//
// Parse failures on individual proxy rows are isolated to the upstreams
// that actually reference them: a single malformed URL must not take down
// every other upstream in the same request. Per-upstream fetchers built
// against a bad row throw at call time rather than at build time, mirroring
// how the dial layer surfaces other dial-time failures.
export const createPerRequestFetcher = async (currentColo: string | null): Promise<(upstreamId: string) => Fetcher> => {
  const repo = getRepo();
  const upstreams = await repo.upstreams.list();
  const fallbackById = new Map(upstreams.map(u => [u.id, u.proxyFallbackList] as const));

  const referencedProxyIds = new Set<string>();
  for (const list of fallbackById.values()) {
    for (const entry of list) {
      if (entry.id !== DIRECT_PROXY_ID) referencedProxyIds.add(entry.id);
    }
  }

  const proxyById = new Map<string, ProxyEntry>();
  const proxyParseErrors = new Map<string, ProxyUriError>();
  if (referencedProxyIds.size > 0) {
    const proxies = await repo.proxies.list();
    for (const p of proxies) {
      if (!referencedProxyIds.has(p.id)) continue;
      try {
        proxyById.set(p.id, {
          config: parseProxyUri(p.url),
          // Carry the per-proxy timeout (seconds → ms) so the dial layer can
          // honour an operator's override; null preserves the gateway default
          // baked into the proxy library.
          dialTimeoutMs: p.dialTimeoutSeconds === null ? null : p.dialTimeoutSeconds * 1000,
        });
      } catch (err) {
        proxyParseErrors.set(p.id, err as ProxyUriError);
      }
    }
  }

  return upstreamId => {
    // Fail loud on an unknown upstream id. Silently substituting `[]`
    // would route the request through `direct` only, masking a stale
    // api-key→upstream binding or a typo in the caller as a working
    // proxy-bypass.
    const list = fallbackById.get(upstreamId);
    if (list === undefined) {
      throw new Error(`unknown upstream id requested from per-request fetcher: ${upstreamId}`);
    }
    const badRefs = list.filter(entry => proxyParseErrors.has(entry.id));
    if (badRefs.length > 0) {
      const first = badRefs[0]!.id;
      const err = proxyParseErrors.get(first)!;
      return async () => {
        throw new Error(`upstream ${upstreamId} references malformed proxy ${first}: ${err.message}`);
      };
    }
    return createFetcher({
      repo,
      upstreamId,
      fallbackList: list,
      currentColo,
      proxyById,
      runProxied: runProxiedRequest,
      runDirect: directFetcher,
      socketDial: getSocketDial,
    });
  };
};

// Control-plane (warm-models, model browse, copilot quota) and background
// flows (codex token refresh, data import) don't carry a data-plane request,
// so there's no colo to derive. Routing through this helper records the
// intent at the call site so the bare `null` isn't read as "forgot to
// thread the colo" by a future reader.
export const createPerRequestFetcherForAdmin = (): Promise<(upstreamId: string) => Fetcher> =>
  createPerRequestFetcher(null);
