import tls from 'node:tls';

// Mirror exactly the trust set Node's own `fetch()` consults so the
// userspace TLS stack is never stricter than the runtime that hosts it.
// `tls.getCACertificates(source)` (Node 22+) reports each source independently;
// 'bundled' is the Mozilla CA list compiled into the Node release, 'system'
// is the platform trust store (macOS Keychain, Windows cert store, Linux
// /etc/ssl/certs) when `--use-system-ca` is on or the platform always
// returns it, and 'extra' is whatever `NODE_EXTRA_CA_CERTS` added at boot.
// Merging the three reproduces Node's effective trust set for outbound TLS.
// Deduplicate because 'bundled' and 'system' overlap on platforms whose
// system store reships Mozilla roots.
const seen = new Set<string>();
const collect = (source: 'bundled' | 'system' | 'extra'): readonly string[] => {
  const pems = tls.getCACertificates(source);
  return pems.filter(pem => {
    if (seen.has(pem)) return false;
    seen.add(pem);
    return true;
  });
};

export const nodeRuntimeRootCAs: readonly string[] = [
  ...collect('bundled'),
  ...collect('system'),
  ...collect('extra'),
];
