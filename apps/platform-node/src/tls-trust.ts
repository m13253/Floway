import tls from 'node:tls';

// Mirror exactly the trust set Node's own `fetch()` consults so the
// userspace TLS stack is never stricter than the runtime that hosts it.
// `tls.getCACertificates(source)` (Node 22+) reports each source independently;
// 'bundled' is the Mozilla CA list compiled into the Node release, 'system'
// is the platform trust store (macOS Keychain, Windows cert store, Linux
// /etc/ssl/certs) when `--use-system-ca` is on or the platform always
// returns it, and 'extra' is whatever `NODE_EXTRA_CA_CERTS` added at boot.
// Merging the three reproduces Node's effective trust set for outbound TLS.
// Deduplicate via a Set because 'bundled' and 'system' overlap on platforms
// whose system store reships Mozilla roots.
export const nodeRuntimeRootCAs: readonly string[] = [...new Set([
  ...tls.getCACertificates('bundled'),
  ...tls.getCACertificates('system'),
  ...tls.getCACertificates('extra'),
])];
