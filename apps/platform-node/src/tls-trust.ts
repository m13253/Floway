import tls from 'node:tls';

// `tls.rootCertificates` is Node's bundled Mozilla CA list, shipped in
// lockstep with the Node release, plus anything Node folded in from
// `NODE_EXTRA_CA_CERTS` at process startup. Reading this snapshot at
// init time and pushing it through the userspace TLS path is what lets
// userspace TLS track the runtime's trust set instead of the frozen
// snapshot baked into `@reclaimprotocol/tls@0.1.2`.
export const nodeRuntimeRootCAs: readonly string[] = tls.rootCertificates;
