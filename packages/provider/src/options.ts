// Indirection contract for outbound HTTP from provider-* packages.
// A concrete Fetcher knows the proxy fallback list of the upstream it was
// built for and routes requests accordingly; provider-* packages never
// construct one themselves.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Default fetcher for any code path that has no proxy story (control-plane
// /models listings, catalog refreshes, OAuth bootstrap). Every call site
// declares whether it wants the proxy chain by passing a fetcher explicitly.
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

export interface FetchOptions {
  extraHeaders?: Record<string, string>;
  fetcher: Fetcher;
}

export interface ProviderFactoryOptions {
  fetcher: Fetcher;
}
