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
  requestBody?: Uint8Array
  // Override the SNI / cert-validation hostname when dialing host:port.
  // Used for local-loopback benches where host=127.0.0.1 but the cert SAN
  // (and therefore the value passed into TLS) is a public hostname.
  sni?: string
}

const SELF_HOST = '23.145.36.136.sslip.io'
// For local benchmarking we dial 127.0.0.1:8443 but keep SNI/cert-validation
// hostname = 23.145.36.136.sslip.io so the same LE cert chain works.
const LOCAL_DIAL_HOST = '127.0.0.1'
const LOCAL_DIAL_PORT = 8443

export function resolveTarget(name: string): TargetSpec | null {
  if (name.startsWith('local-')) return resolveLocalTarget(name.slice('local-'.length))
  switch (name) {
    case 'echo':
      return baseSelf('/echo')
    case 'sse':
      return baseSelf('/sse')
    case 'chunked':
      return baseSelf('/chunked')
    case 'large':
      return baseSelf('/large-5mb.bin')
    case 'large-5mb':
      return baseSelf('/large-5mb.bin')
    case 'large-500k':
      return baseSelf('/large-500k.bin')
    case 'slow':
      return baseSelf('/slow')
    case 'abort':
      return baseSelf('/abort')
    case 'sleep-then-200':
      return baseSelf('/sleep-then-200')
    case 'upload-500k':
      return uploadSelf(500 * 1024)
    case 'upload-5mb':
      return uploadSelf(5 * 1024 * 1024)
    case 'httpbin':
      return base('httpbin.org', 443, '/get')
    case 'cf':
      return base('www.cloudflare.com', 443, '/')
    case 'wrong-sni':
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

function uploadSelf(bytes: number): TargetSpec {
  // POST a large random body and read the small JSON response. Mirrors the
  // typical LLM gateway shape: long agent history → short tool-call reply.
  const body = new Uint8Array(bytes)
  // Fill with deterministic non-zero bytes so AEAD has real work to do (zero
  // plaintext compresses to nothing in benchmarks but real chacha20 is the
  // same cost regardless; this is just for hygiene).
  for (let i = 0; i < body.byteLength; i++) body[i] = (i * 31 + 7) & 0xff
  return {
    url: `https://${SELF_HOST}/echo`,
    host: SELF_HOST,
    port: 443,
    tls: true,
    path: '/echo',
    method: 'POST',
    headers: {
      Host: SELF_HOST,
      'User-Agent': 'proxy-dial-test/0.1',
      Accept: '*/*',
      'Content-Type': 'application/octet-stream',
      'Content-Length': String(body.byteLength),
    },
    requestBody: body,
  }
}

function resolveLocalTarget(name: string): TargetSpec | null {
  // The local upstream listens on 127.0.0.1:8443 but presents the same
  // cert as 23.145.36.136.sslip.io, so we dial the IP and keep the SNI.
  const path = (
    name === 'echo'        ? '/echo' :
    name === 'sse'         ? '/sse' :
    name === 'large-500k'  ? '/large-500k.bin' :
    name === 'large-5mb'   ? '/large-5mb.bin' :
    name === 'upload-500k' ? '/echo' :
    name === 'upload-5mb'  ? '/echo' :
    null
  )
  if (path === null) return null
  const isUpload = name.startsWith('upload-')
  const headers: Record<string, string> = {
    Host: SELF_HOST,
    'User-Agent': 'proxy-dial-test/0.1',
    Accept: '*/*',
  }
  let body: Uint8Array | undefined
  if (isUpload) {
    const bytes = name === 'upload-500k' ? 500 * 1024 : 5 * 1024 * 1024
    body = getCachedBenchBody(bytes)
    headers['Content-Type'] = 'application/octet-stream'
    headers['Content-Length'] = String(body.byteLength)
  }
  return {
    url: `https://${SELF_HOST}:${LOCAL_DIAL_PORT}${path}`,
    host: LOCAL_DIAL_HOST,
    port: LOCAL_DIAL_PORT,
    tls: true,
    path,
    method: isUpload ? 'POST' : 'GET',
    headers,
    requestBody: body,
    sni: SELF_HOST,
  }
}

// Cache deterministic test-fixture bodies across requests so the per-request
// body allocation and fill-loop don't dominate the CPU profile (a 5 MiB body
// fill alone showed up as ~25% of total request CPU before this).
const benchBodyCache = new Map<number, Uint8Array>()
function getCachedBenchBody(bytes: number): Uint8Array {
  const cached = benchBodyCache.get(bytes)
  if (cached) return cached
  const body = new Uint8Array(bytes)
  for (let i = 0; i < body.byteLength; i++) body[i] = (i * 31 + 7) & 0xff
  benchBodyCache.set(bytes, body)
  return body
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
