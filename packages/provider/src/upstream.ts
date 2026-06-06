// Indirection for outbound HTTP from provider-* packages. The gateway
// builds a concrete UpstreamFetch instance per request that knows the
// upstream's proxy fallback list, the proxies catalog, and the backoff
// repo, and routes each call through runProxiedRequest with the correct
// proxy. provider-* packages never import @floway-dev/proxy directly.
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
  // When present, the per-endpoint fetch helper dispatches through this
  // proxy-aware indirection instead of `globalThis.fetch`. The provider
  // factory captures it from its constructor `options.fetcher` and threads
  // it through every transport call site.
  fetcher?: UpstreamFetch;
}
