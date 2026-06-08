// Public type surface for proxy-dial.
//
// The dial layer is transport-only. `DialTarget` describes WHERE to land
// after the proxy hop completes — host + port — and nothing else. TLS,
// SNI, ALPN, and HTTP-shaped concerns live one layer up in the
// orchestrator (runProxiedRequest).

import { ProxyDialError } from './errors.ts';

/** Pure transport target: where the proxy should land us. */
export interface DialTarget {
  /**
   * TCP host the proxy should reach on our behalf. Can be a hostname (resolved
   * by the proxy's resolver) or a literal IPv4/IPv6 address.
   */
  host: string;
  /** TCP port. */
  port: number;
}

/**
 * Reject a port outside the 1..65535 range used by TCP. Port 0 is
 * reserved (RFC 6335 §6) — its presence on the wire is almost always
 * a config bug. We surface a typed dial error before any I/O so the
 * fallback chain can advance to the next proxy entry. */
export const assertValidTargetPort = (port: number, protocol: string): void => {
  if (!Number.isInteger(port) || port < 1 || port > 65535) {
    throw new ProxyDialError(`${protocol}: target port must be 1..65535, got ${port}`, 'proxy-handshake');
  }
};

/**
 * Request-time target for the orchestrator: a DialTarget plus the
 * inner-TLS parameters needed to wrap the post-dial stream.
 *
 * Defaults flow `host → sni → verifyHost`. Override any one slot for
 * use cases like:
 *
 *   - **Domain fronting**: `host` and `sni` point at the front
 *     (e.g. a CDN edge), the HTTP request's `Host:` carries the real
 *     upstream name.
 *   - **Dial-by-IP**: `host` is a literal IP, `sni` and `verifyHost`
 *     are the cert's hostname.
 *   - **SNI hiding**: `sni` is benign, `verifyHost` is internal.
 */
export interface ProxyRequestTarget extends DialTarget {
  /** Whether to wrap the post-proxy byte stream with TLS to the upstream. */
  tls: boolean;

  /**
   * TLS ClientHello `server_name` extension value. Defaults to `host`.
   * If `host` is an IP, set this explicitly — IPs in SNI are invalid.
   */
  sni?: string;

  /**
   * Hostname the upstream's certificate chain must prove. Defaults to
   * `sni` (which itself defaults to `host`).
   */
  verifyHost?: string;

  /** Optional ALPN protocol list for the inner TLS handshake. */
  alpn?: string[];
}

/** SNI for a request target. `sni` if set, else `host`. */
export const resolveSni = (target: ProxyRequestTarget): string =>
  target.sni ?? target.host;

/** Cert-verify hostname for a request target. `verifyHost` if set, else `sni`, else `host`. */
export const resolveVerifyHost = (target: ProxyRequestTarget): string =>
  target.verifyHost ?? target.sni ?? target.host;

// SocketDial is a runtime-agnostic byte-stream dial primitive. The proxy
// package does NOT depend on any runtime — the caller threads in a
// concrete impl (Workers' `cloudflare:sockets`, Node's `node:net`, etc.)
// via DialOptions.socketDial.

export interface SocketDialOptions {
  /**
   * Wrap the connection with the runtime's native TLS implementation.
   * The hostname is reused as SNI and as the certificate-verify name.
   * Useful when the proxy protocol's outer leg is plain TLS — userspace
   * TLS works too but native TLS is faster.
   */
  tls?: boolean;
  /**
   * Caller-supplied cancellation. When the signal aborts:
   *   - mid-connect dials are torn down immediately;
   *   - established sockets are closed by the runtime impl, which then
   *     surfaces as read/write rejections to the proxy library.
   */
  signal?: AbortSignal;
}

export interface DialedSocket {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  /** Idempotent close. */
  close(): Promise<void>;
}

export interface SocketDial {
  connect(host: string, port: number, opts?: SocketDialOptions): Promise<DialedSocket>;
}

/**
 * Output of a per-protocol `dial`. The duplex stream points at
 * `target.host:target.port` (after the proxy's framing has been peeled
 * off). `prefix`, when present, is bytes the dialer wants prepended to
 * the very first record the orchestrator emits next — Trojan uses this
 * to inline its 56-byte auth header into the same TLS record / TCP
 * segment as the request line, so a sing-box inbound's `conn.Read(56)`
 * doesn't short-read on a leading fragment.
 */
export interface DialResult {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
  prefix?: Uint8Array;
}

export interface DialOptions {
  /** Caller-supplied cancellation, threaded through every dial leg. */
  signal?: AbortSignal;
  /** Per-call dial-stage deadline override (ms). Falls back to
   *  DEFAULT_DIAL_DEADLINE_MS when absent. */
  dialTimeoutMs?: number;
  /**
   * Platform-injected raw TCP dial primitive. Required — every dialer
   * needs to open at least one TCP connection (the VLESS-WS dialer uses
   * runtime fetch instead and ignores this).
   */
  socketDial: SocketDial;
}
