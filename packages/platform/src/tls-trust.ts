// Resolves the runtime's trust set for userspace TLS.
//
// `@reclaimprotocol/tls@0.1.2` validates server certificates against a frozen
// snapshot of Mozilla's CA list baked into the package — a snapshot that
// stops gaining new roots the moment the package is published. Operators
// chaining upstream certs through a recently-added root would fail
// validation in userspace TLS even though the runtime's own trust store
// would accept them. Each apps/platform-* impl plugs in the runtime's
// trust store (Node: `tls.rootCertificates`, plus `NODE_EXTRA_CA_CERTS` if
// set); on runtimes with no public API for it (workerd), the impl returns
// null and userspace TLS falls back to the library bundle.

export type GetRuntimeRootCAs = () => readonly string[] | null;

let current: GetRuntimeRootCAs | null = null;

export const initRuntimeRootCAs = (fn: GetRuntimeRootCAs): void => {
  current = fn;
};

export const getRuntimeRootCAs = (): GetRuntimeRootCAs => {
  if (!current) throw new Error('RuntimeRootCAs not initialized');
  return current;
};

/** Test-only: clears the module singleton. */
export const resetRuntimeRootCAsForTesting = (): void => {
  current = null;
};
