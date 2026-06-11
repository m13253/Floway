// Indirection for outbound HTTP so per-upstream proxy chains can be
// threaded by reference.
//
// `recordUpstreamLatency` is the per-call upstream-latency recorder the
// gateway threads down to the dial layer. The proxy-fallback fetcher wraps
// each individual dial attempt with it so the recorder's "last wrap wins"
// semantics let only the successful dial's measurement survive — failed
// attempts in the fallback chain are not part of the upstream-latency
// metric. Catalog-refresh and other plumbing call sites pass nothing; the
// fetcher then runs the inner fetch unwrapped.
export type Fetcher = (
  url: string,
  init: RequestInit,
  recordUpstreamLatency?: <T>(promise: Promise<T>) => Promise<T>,
) => Promise<Response>;

// Plain runtime fetch as a Fetcher, used at sites where there is no
// upstream id to key a per-upstream proxy chain off.
export const directFetcher: Fetcher = (url, init) => fetch(url, init);

// Per-call options for upstream fetch helpers: a per-upstream Fetcher plus
// optional headers merged on top of the helper's own default headers.
// `recordUpstreamLatency` rides alongside the fetcher so the helper can pass
// it as the third arg without each provider repeating the plumbing.
export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
  fetcher: Fetcher;
  recordUpstreamLatency?: <T>(promise: Promise<T>) => Promise<T>;
}
