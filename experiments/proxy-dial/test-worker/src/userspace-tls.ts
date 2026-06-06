// Userspace TLS adapter over a raw plain-TCP `cloudflare:sockets` Socket.
//
// We need this because `Socket.startTls()` on Workers production edge fails
// with "TLS Handshake Failed." after any plain bytes have been read or written
// (workerd issue #2712, unresolved). The same bug means our HTTP CONNECT and
// SOCKS5 paths cannot complete the upstream TLS handshake natively.
//
// `@reclaimprotocol/tls` provides a TLS 1.2/1.3 client implemented in JS using
// Web Crypto + @noble. We wrap it as an adapter that takes a plain Socket and
// returns a fresh { readable, writable } pair carrying the upstream's
// decrypted application data.

import { connect } from 'cloudflare:sockets'
import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls'
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto'

let cryptoInstalled = false
function ensureCrypto(): void {
  if (cryptoInstalled) return
  setCryptoImplementation(webcryptoCrypto)
  cryptoInstalled = true
}

export interface UserspaceTlsOptions {
  host: string
  alpn?: string[]
  // When false, we pass the cert chain through reclaim's verifier as-is.
  // When true, all certs are accepted — only useful in test paths.
  insecure?: boolean
  // Optional bytes prepended to our first record write to the transport. Used
  // when the proxy protocol's request header must be transmitted in the same
  // TCP segment as our first TLS ClientHello (e.g. sing-box's Trojan inbound
  // uses `conn.Read(key[56])` and short-reads if the proxy header arrives in
  // a separate TLS fragment from the rest of the stream).
  prefix?: Uint8Array
}

export interface TlsStream {
  readable: ReadableStream<Uint8Array>
  writable: WritableStream<Uint8Array>
}

// Wrap a duplex byte transport (typically a Worker `Socket` after the proxy
// handshake completes) with a TLS 1.3 client and emit an application-data
// duplex stream.
//
// On error the returned promise rejects; on TLS clean-end the readable closes;
// on any error after handshake the readable errors.
export async function userspaceTls(
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  opts: UserspaceTlsOptions,
): Promise<TlsStream> {
  ensureCrypto()

  const writer = transport.writable.getWriter()

  // App-data downward stream (TLS plaintext → consumer)
  let plainController!: ReadableStreamDefaultController<Uint8Array>
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c },
  })

  // App-data upward stream (consumer → TLS encrypt → transport)
  // We construct the writable AFTER the TLS client exists so its write hook can
  // call tls.write directly. Use a placeholder; reassigned below.
  let tlsClient: ReturnType<typeof makeTLSClient> | null = null
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!tlsClient) throw new Error('TLS not ready')
      await tlsClient.write(chunk)
    },
    async close() {
      try { await tlsClient?.end() } catch {}
      try { writer.close() } catch {}
    },
    abort(reason) {
      try { tlsClient?.end() } catch {}
      try { writer.abort(reason) } catch {}
    },
  })

  // Resolve when the handshake succeeds; reject on TLS-end or error before then.
  let handshakeResolve!: () => void
  let handshakeReject!: (e: unknown) => void
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve
    handshakeReject = reject
  })

  let handshakeOk = false

  let pendingPrefix: Uint8Array | null = opts.prefix ?? null

  tlsClient = makeTLSClient({
    host: opts.host,
    verifyServerCertificate: !opts.insecure,
    applicationLayerProtocols: opts.alpn,
    write({ header, content }) {
      const prefixLen = pendingPrefix ? pendingPrefix.byteLength : 0
      const out = new Uint8Array(prefixLen + header.byteLength + content.byteLength)
      let off = 0
      if (pendingPrefix) {
        out.set(pendingPrefix, 0); off += prefixLen
        pendingPrefix = null
      }
      out.set(header, off); off += header.byteLength
      out.set(content, off)
      writer.write(out).catch((e) => {
        if (!handshakeOk) handshakeReject(e)
        else plainController?.error(e)
      })
    },
    async onHandshake() {
      handshakeOk = true
      handshakeResolve()
    },
    onApplicationData(plaintext) {
      if (plainController) plainController.enqueue(copy(plaintext))
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        handshakeReject(error ?? new Error('TLS ended before handshake'))
        return
      }
      if (error) plainController?.error(error)
      else plainController?.close()
      try { writer.close() } catch {}
    },
  })

  // Pump bytes from transport → tls.handleReceivedBytes
  ;(async () => {
    const reader = transport.readable.getReader()
    try {
      while (true) {
        const { value, done } = await reader.read()
        if (done) {
          tlsClient?.end().catch(() => {})
          return
        }
        await tlsClient?.handleReceivedBytes(value)
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e)
      else plainController?.error(e)
    } finally {
      try { reader.releaseLock() } catch {}
    }
  })()

  await tlsClient.startHandshake()
  await handshakeDone

  return { readable: plainReadable, writable: plainWritable }
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength)
  r.set(u)
  return r
}

// Convenience: open a plain TCP socket and immediately wrap it in TLS.
export async function connectTls(host: string, port: number, opts?: { alpn?: string[]; insecure?: boolean }): Promise<TlsStream> {
  const sock = connect({ hostname: host, port }, { secureTransport: 'off', allowHalfOpen: true })
  return await userspaceTls(sock, { host, alpn: opts?.alpn, insecure: opts?.insecure })
}
