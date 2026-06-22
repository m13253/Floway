import tls from 'node:tls';

// Match the trust set Node's own `fetch()` uses so userspace TLS is never
// stricter than the host runtime. Dedupe because 'bundled' and 'system'
// overlap on platforms whose system store reships Mozilla roots.
export const nodeRuntimeRootCAs: readonly string[] = [...new Set([
  ...tls.getCACertificates('bundled'),
  ...tls.getCACertificates('system'),
  ...tls.getCACertificates('extra'),
])];
