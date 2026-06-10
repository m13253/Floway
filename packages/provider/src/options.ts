// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
export type Fetcher = (url: string, init: RequestInit) => Promise<Response>;

// Plain runtime fetch as a Fetcher, used at sites where there is no
// upstream id to key a per-upstream proxy chain off.
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

// Per-call options for upstream fetch helpers: a per-upstream Fetcher plus
// optional headers merged on top of the helper's own auth/intent/UA headers.
export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
  fetcher: Fetcher;
}
