// Public type surface for proxy-dial protocols.
//
// A `TargetSpec` describes the upstream HTTP(S) endpoint and the request to
// issue against it after the proxy hop completes. Each protocol implementation
// in `protocols/` consumes a `TargetSpec` plus its own per-protocol options.

export interface TargetSpec {
  /** Upstream hostname for cert validation and the Host header. */
  host: string
  /** Upstream TCP port. */
  port: number
  /** Whether the upstream is HTTPS (we'll do TLS to it after the proxy hop). */
  tls: boolean
  /** HTTP method for the upstream request. */
  method: string
  /** Upstream request path + query string. */
  path: string
  /** Upstream request headers. The Host header is auto-injected if absent. */
  headers: Record<string, string>
  /** Optional request body. */
  requestBody?: Uint8Array
  /**
   * Override the SNI / cert-validation hostname when dialing `host:port`.
   * Useful when `host` is a literal IP that should be reached but the cert
   * SAN is a different name. Defaults to `host`.
   */
  sni?: string
}
