// Userspace TLS adapter over a raw plain-TCP byte transport.
//
// On Cloudflare Workers, `Socket.startTls()` on the production edge fails with
// "TLS Handshake Failed." after any plain bytes have been read or written
// (workerd issue #2712, unresolved). The same bug means our HTTP CONNECT and
// SOCKS5 paths cannot complete the upstream TLS handshake natively. We
// therefore use a userspace TLS client uniformly across all runtimes so the
// proxy library does not depend on any runtime-specific TLS upgrade.
//
// `@reclaimprotocol/tls` provides a TLS 1.2/1.3 client implemented in JS using
// Web Crypto + @noble. We wrap it as an adapter that takes a duplex byte
// transport and returns a fresh { readable, writable } pair carrying the
// upstream's decrypted application data.

import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';

let cryptoInstalled = false;
function ensureCrypto(): void {
  if (cryptoInstalled) return;
  setCryptoImplementation(webcryptoCrypto);
  cryptoInstalled = true;
}

export interface UserspaceTlsOptions {
  /**
   * TLS ClientHello server_name extension and (unless `verifyHost` is set)
   * the hostname against which the cert chain is validated.
   */
  host: string;
  /**
   * Override the cert-validation hostname independently from `host` (the
   * SNI). The cert's SAN/CN must prove this name. Defaults to `host`.
   */
  verifyHost?: string;
  alpn?: string[];
  /**
   * When true, all server certificates are accepted (no chain validation,
   * no name match). Test-only.
   */
  insecure?: boolean;
  /**
   * Optional bytes prepended to our first record write to the transport.
   * Used when the proxy protocol's request header must be transmitted in
   * the same TCP segment as our first TLS ClientHello (e.g. sing-box's
   * Trojan inbound uses `conn.Read(key[56])` and short-reads if the proxy
   * header arrives in a separate TLS fragment from the rest of the stream).
   */
  prefix?: Uint8Array;
  /**
   * Force TLS 1.3 cipher suites. Defaults to the AES-GCM suites which use
   * Web Crypto's hardware-accelerated AES-NI path on Workers; ChaCha20-
   * Poly1305 falls back to @noble/ciphers' pure-JS impl which is much
   * slower for the typical record sizes our HTTP/1.1 traffic produces.
   */
  cipherSuites?: Array<'TLS_AES_256_GCM_SHA384' | 'TLS_AES_128_GCM_SHA256' | 'TLS_CHACHA20_POLY1305_SHA256'>;
}

export interface TlsStream {
  readable: ReadableStream<Uint8Array>;
  writable: WritableStream<Uint8Array>;
}

// Wrap a duplex byte transport (typically a `DialedSocket` after the proxy
// handshake completes) with a TLS 1.3 client and emit an application-data
// duplex stream.
//
// On error the returned promise rejects; on TLS clean-end the readable closes;
// on any error after handshake the readable errors.
export async function userspaceTls(
  transport: { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> },
  opts: UserspaceTlsOptions,
): Promise<TlsStream> {
  ensureCrypto();

  const writer = transport.writable.getWriter();

  // App-data downward stream (TLS plaintext → consumer)
  let plainController!: ReadableStreamDefaultController<Uint8Array>;
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    // Consumer-initiated cancel (response body fully read or aborted) tears
    // down our side of the duplex — flag so subsequent TLS-end callbacks
    // skip their controller calls, and signal end-of-stream upward.
    cancel() {
      plainClosed = true;
      tlsClient?.end().catch(() => {});
      writer.close().catch(() => {});
    },
  });

  // App-data upward stream (consumer → TLS encrypt → transport)
  // We construct the writable AFTER the TLS client exists so its write hook can
  // call tls.write directly. Use a placeholder; reassigned below.
  let tlsClient: ReturnType<typeof makeTLSClient> | null = null;
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      if (!tlsClient) throw new Error('TLS not ready');
      await tlsClient.write(chunk);
    },
    async close() {
      // Both promises must be awaited or attached with .catch — a bare
      // `void promise` discards rejection and crashes Node with
      // unhandled-rejection when the underlying stream is already closed.
      await tlsClient?.end().catch(() => {});
      await writer.close().catch(() => {});
    },
    async abort(reason) {
      await tlsClient?.end().catch(() => {});
      await writer.abort(reason).catch(() => {});
    },
  });

  // Resolve when the handshake succeeds; reject on TLS-end or error before then.
  let handshakeResolve!: () => void;
  let handshakeReject!: (e: unknown) => void;
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });

  let handshakeOk = false;
  // Two independent paths can drop the plaintext stream out from under us:
  // (1) reclaim's TLS client fires `onTlsEnd` once for the peer CLOSE_NOTIFY
  //     alert and again when the underlying transport reader returns done;
  // (2) the consumer (Hono / fetch) cancels the readable after it has the
  //     full response, which closes the controller from the outside. Either
  //     way, a follow-up `controller.close()` / `controller.error()` /
  //     `controller.enqueue()` throws ERR_INVALID_STATE — and on Node there
  //     is no error event to swallow it, so the whole worker crashes. Latch
  //     the close on our side, and treat any throw from the controller as
  //     "already closed by the consumer."
  let plainClosed = false;
  const safeClose = (): void => {
    try { plainController?.close(); } catch {}
  };
  const safeError = (error: unknown): void => {
    try { plainController?.error(error); } catch {}
  };
  const safeEnqueue = (chunk: Uint8Array<ArrayBuffer>): void => {
    try { plainController?.enqueue(chunk); } catch { plainClosed = true; }
  };
  const closePlain = (error?: unknown): void => {
    if (plainClosed) return;
    plainClosed = true;
    if (error) safeError(error);
    else safeClose();
    writer.close().catch(() => {});
  };

  let pendingPrefix: Uint8Array | null = opts.prefix ?? null;

  tlsClient = makeTLSClient(({
    host: opts.host,
    verifyHost: opts.verifyHost,
    verifyServerCertificate: !opts.insecure,
    applicationLayerProtocols: opts.alpn,
    // Default to AES-GCM only because reclaim routes those through Web
    // Crypto, which is hardware-accelerated by V8 (AES-NI on x86, the SHA
    // extensions on ARM). ChaCha20-Poly1305 in reclaim falls back to
    // @noble/ciphers' pure-JS impl, which is ~5-10× slower per byte.
    cipherSuites: opts.cipherSuites ?? ['TLS_AES_256_GCM_SHA384', 'TLS_AES_128_GCM_SHA256'],
    write({ header, content }) {
      const prefixLen = pendingPrefix ? pendingPrefix.byteLength : 0;
      const out = new Uint8Array(prefixLen + header.byteLength + content.byteLength);
      let off = 0;
      if (pendingPrefix) {
        out.set(pendingPrefix, 0); off += prefixLen;
        pendingPrefix = null;
      }
      out.set(header, off); off += header.byteLength;
      out.set(content, off);
      writer.write(out).catch(e => {
        if (!handshakeOk) handshakeReject(e);
        else closePlain(e);
      });
    },
    onHandshake() {
      handshakeOk = true;
      handshakeResolve();
    },
    onApplicationData(plaintext) {
      if (plainClosed) return;
      safeEnqueue(copy(plaintext));
    },
    onTlsEnd(error) {
      if (!handshakeOk) {
        handshakeReject(error ?? new Error('TLS ended before handshake'));
        return;
      }
      closePlain(error);
    },
  } as Parameters<typeof makeTLSClient>[0]));

  // Pump bytes from transport → tls.handleReceivedBytes
  void (async () => {
    const reader = transport.readable.getReader();
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          tlsClient?.end().catch(() => {});
          return;
        }
        await tlsClient?.handleReceivedBytes(value);
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e);
      else closePlain(e);
    } finally {
      try { reader.releaseLock(); } catch {}
    }
  })();

  await tlsClient.startHandshake();
  await handshakeDone;

  return { readable: plainReadable, writable: plainWritable };
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
}
