// Indirection contract for outbound HTTP from provider-* packages.
// A concrete Fetcher knows the proxy fallback list of the upstream it was
// built for and routes requests accordingly; provider-* packages never
// construct one themselves.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Plain runtime fetch as a Fetcher. Every call site declares whether it
// wants the per-upstream proxy chain by passing a fetcher explicitly; this
// constant is the choice for the few paths where there is no upstream id
// to key a chain off — the gateway's `direct` fallback impl, the pre-save
// custom-config validation flow (no row exists yet), and the Codex PKCE
// token exchange (the upstream is created from the response).
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

export interface FetchOptions {
  extraHeaders?: Record<string, string>;
  fetcher: Fetcher;
}

export interface ProviderFactoryOptions {
  fetcher: Fetcher;
}
