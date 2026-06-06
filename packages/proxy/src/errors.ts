// Surfaced by every protocol runner when the dial / proxy-handshake /
// inner-TLS handshake fails — i.e. when the upstream server has not
// observed any byte of our request yet. The gateway uses this signal to
// drive proxy_upstream_backoffs (see spec §6.1).
//
// Anything thrown after the upstream sees our request is NOT a
// ProxyDialError — that's the upstream's problem.

export class ProxyDialError extends Error {
  override readonly name = 'ProxyDialError'

  constructor(
    message: string,
    /** Where in the dial path the failure happened. */
    readonly stage:
      | 'tcp-connect'
      | 'outer-tls'
      | 'proxy-handshake'
      | 'inner-tls',
    options?: { cause?: unknown },
  ) {
    super(message, options)
  }
}
