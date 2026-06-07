// Indirection contract for outbound HTTP from provider-* packages.
// A concrete UpstreamFetch knows the upstream's proxy fallback list and
// routes requests accordingly; provider-* packages never construct one
// themselves.
export type UpstreamFetch = (url: string, init: RequestInit) => Promise<Response>;

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
  // Per-call override: when present, the per-endpoint fetch helper dispatches through this proxy-aware indirection instead of `globalThis.fetch`.
  fetcher?: UpstreamFetch;
}

export interface ProviderFactoryOptions {
  fetcher?: UpstreamFetch;
}
