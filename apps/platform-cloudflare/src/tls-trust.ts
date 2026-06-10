// workerd does not expose its trust store to userspace — the runtime's
// own `cloudflare:sockets` TLS consults Cloudflare's internal CA list but
// nothing about that set is reachable from a Worker. Falling back to an
// empty list leaves userspace TLS validating against
// `@reclaimprotocol/tls@0.1.2`'s frozen Mozilla bundle.
export const cloudflareRuntimeRootCAs: readonly string[] = [];
