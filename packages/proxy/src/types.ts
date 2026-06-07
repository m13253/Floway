// Public type surface for proxy-dial protocols.

/**
 * Describes (1) where to dial, (2) what TLS handshake to do to the upstream,
 * and (3) what HTTP/1.1 request to send. The three identity-like fields
 * (dialHost, tlsSni, tlsVerifyHost) and the Host header are all independent
 * for maximum flexibility:
 *
 *   - `dialHost`        TCP endpoint (hostname or IP) used by `connect()`.
 *   - `tlsSni`          ClientHello `server_name` extension byte payload.
 *   - `tlsVerifyHost`   Hostname the cert chain must prove (matched against
 *                       cert SAN/CN at chain validation time).
 *   - `headers.Host`    HTTP/1.1 `Host:` header.
 *
 * Defaults flow `dialHost → tlsSni → tlsVerifyHost`. Override any one slot
 * for use cases like:
 *
 *   - **Domain fronting**: `dialHost` and `tlsSni` point at the front
 *     (e.g. a CDN edge), `headers.Host` carries the real upstream name.
 *   - **Dial-by-IP**: `dialHost` is a literal IP, `tlsSni` and
 *     `tlsVerifyHost` are the cert's hostname.
 *   - **SNI hiding** (Workers can't do REALITY-style SNI/cert split, but
 *     general use cases like internal services with arbitrary cert SANs
 *     fit fine): `tlsSni` is benign, `tlsVerifyHost` is internal.
 */
export interface TargetSpec {
  /**
   * TCP host to connect to. Can be a hostname (resolved by the runtime's
   * resolver) or a literal IPv4/IPv6 address.
   */
  dialHost: string;
  /** TCP port. */
  port: number;
  /** Whether to wrap the post-proxy byte stream with TLS to the upstream. */
  tls: boolean;

  /**
   * TLS ClientHello `server_name` extension value. Defaults to `dialHost`.
   * If `dialHost` is an IP, set this explicitly — IPs in SNI are invalid.
   */
  tlsSni?: string;

  /**
   * Hostname the upstream's certificate chain must prove. Defaults to
   * `tlsSni` (which itself defaults to `dialHost`). Independent from
   * `tlsSni` because SNI is what the *server* sees and certificate
   * verification is what the *client* checks; a request can want them to
   * differ.
   */
  tlsVerifyHost?: string;

  /** HTTP/1.1 method. */
  method: string;
  /** HTTP/1.1 path + query string. */
  path: string;
  /**
   * HTTP/1.1 request headers. The `Host:` header (case-insensitive) is
   * inserted from `dialHost` if absent; set it explicitly to send something
   * else (e.g. for domain fronting).
   */
  headers: Record<string, string>;
  /** Optional request body. */
  requestBody?: Uint8Array;
}

/**
 * Resolves the SNI used for a TargetSpec. `tlsSni` if set, else `dialHost`.
 */
export function resolveTlsSni(target: TargetSpec): string {
  return target.tlsSni ?? target.dialHost;
}

/**
 * Resolves the cert-verify hostname for a TargetSpec. `tlsVerifyHost` if
 * set, else falls back through `tlsSni`, else `dialHost`.
 */
export function resolveTlsVerifyHost(target: TargetSpec): string {
  return target.tlsVerifyHost ?? target.tlsSni ?? target.dialHost;
}
