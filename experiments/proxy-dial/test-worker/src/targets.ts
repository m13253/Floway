// Target catalog — maps short names (echo, sse, …) to a concrete HTTP/1.1 request
// that the Worker should issue against an upstream after dialing through a proxy.
//
// Every target's `host`/`port`/`tls` is what to dial. `path`/`method`/`headers`
// is the HTTP/1.1 request to send.

export interface TargetSpec {
  url: string
  host: string
  port: number
  tls: boolean
  path: string
  method: string
  headers: Record<string, string>
}

const SELF_HOST = '23.145.36.136.sslip.io'

export function resolveTarget(name: string): TargetSpec | null {
  switch (name) {
    case 'echo':
      return baseSelf('/echo')
    case 'sse':
      return baseSelf('/sse')
    case 'chunked':
      return baseSelf('/chunked')
    case 'large':
      return baseSelf('/large-5mb.bin')
    case 'slow':
      return baseSelf('/slow')
    case 'abort':
      return baseSelf('/abort')
    case 'sleep-then-200':
      return baseSelf('/sleep-then-200')
    case 'httpbin':
      return base('httpbin.org', 443, '/get')
    case 'cf':
      return base('www.cloudflare.com', 443, '/')
    case 'wrong-sni':
      // Dial 23.145.36.136.sslip.io:443 (IP) but tell TLS the host is "wrong.example.com".
      // The LE cert's SAN is 23.145.36.136.sslip.io only, so handshake must fail
      // when the cert is verified against the bogus name.
      return {
        url: 'https://wrong.example.com/echo',
        host: 'wrong.example.com',
        port: 443,
        tls: true,
        path: '/echo',
        method: 'GET',
        headers: { Host: 'wrong.example.com', 'User-Agent': 'proxy-dial-test/0.1', Accept: '*/*' },
      }
    case 'expired':
      return base('expired.badssl.com', 443, '/')
    case 'self-signed':
      return base('self-signed.badssl.com', 443, '/')
    default:
      return null
  }
}

function baseSelf(path: string): TargetSpec {
  return base(SELF_HOST, 443, path)
}

function base(host: string, port: number, path: string): TargetSpec {
  return {
    url: `https://${host}${path}`,
    host,
    port,
    tls: port === 443,
    path,
    method: 'GET',
    headers: { Host: host, 'User-Agent': 'proxy-dial-test/0.1', Accept: '*/*' },
  }
}
