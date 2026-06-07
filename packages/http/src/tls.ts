// Userspace TLS adapter over a raw plain-TCP byte transport.
//
// On Cloudflare Workers, `Socket.startTls()` on the production edge fails with
// "TLS Handshake Failed." after any plain bytes have been read or written
// (workerd issue #2712, unresolved). The same bug means HTTP CONNECT and
// SOCKS5 paths cannot complete the upstream TLS handshake natively. We
// therefore use a userspace TLS client uniformly across all runtimes so this
// package does not depend on any runtime-specific TLS upgrade.
//
// `@reclaimprotocol/tls` provides a TLS 1.2/1.3 client implemented in JS using
// Web Crypto + @noble. We wrap it as an adapter that takes a duplex byte
// transport and returns a fresh { readable, writable } pair carrying the
// upstream's decrypted application data.

import { makeTLSClient, setCryptoImplementation } from '@reclaimprotocol/tls';
import { webcryptoCrypto } from '@reclaimprotocol/tls/webcrypto';

import type { DuplexStream } from './types.ts';

let cryptoInstalled = false;
const ensureCrypto = (): void => {
  if (cryptoInstalled) return;
  setCryptoImplementation(webcryptoCrypto);
  cryptoInstalled = true;
};

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
   * Used when a proxy protocol's request header must be transmitted in
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
  /**
   * Cancellation. Aborting before or during the handshake rejects the
   * userspaceTls promise, cancels the read pump, and releases the writer
   * lock so the caller can close the transport. After the handshake, the
   * caller's ReadableStream cancel/WritableStream abort drive teardown.
   */
  signal?: AbortSignal;
}

export type TlsStream = DuplexStream;

// Wrap a duplex byte transport with a TLS 1.3 client and emit an
// application-data duplex stream.
//
// On error the returned promise rejects; on TLS clean-end the readable closes;
// on any error after handshake the readable errors.
export const userspaceTls = async (
  transport: DuplexStream,
  opts: UserspaceTlsOptions,
): Promise<TlsStream> => {
  ensureCrypto();

  if (opts.signal?.aborted) {
    throw new DOMException(String(opts.signal.reason ?? 'aborted'), 'AbortError');
  }

  const writer = transport.writable.getWriter();
  const reader = transport.readable.getReader();

  // Detach the abort listener on every teardown path so a long-lived caller
  // signal (e.g. a request controller shared across many dials) doesn't
  // accumulate one closure per dial pinning the closed-over streams.
  let detachAbortListener: (() => void) | null = null;
  const cleanupSignal = (): void => {
    detachAbortListener?.();
    detachAbortListener = null;
  };

  // App-data downward stream (TLS plaintext → consumer)
  let plainController!: ReadableStreamDefaultController<Uint8Array>;
  const plainReadable = new ReadableStream<Uint8Array>({
    start(c) { plainController = c; },
    // Consumer-initiated cancel (response body fully read or aborted) tears
    // down our side of the duplex — flag so subsequent TLS-end callbacks
    // skip their controller calls, and signal end-of-stream upward.
    cancel() {
      plainClosed = true;
      cleanupSignal();
      void tlsClient?.end().catch(logTlsTeardownError);
      void reader.cancel().catch(() => {});
      void writer.close().catch(logTlsTeardownError);
    },
  });

  // App-data upward stream (consumer → TLS encrypt → transport). Declared
  // before makeTLSClient so its write hook can capture this writer; the
  // hooks below close over the let-bound `tlsClient` slot, which is filled
  // synchronously below before the function awaits the handshake. By the
  // time the consumer ever calls write/close/abort, the duplex pair has
  // already been returned (see `await handshakeDone` further down), so the
  // tlsClient reference is guaranteed non-null for write and the optional
  // chains in close/abort cover the synchronous-teardown paths only.
  let tlsClient: ReturnType<typeof makeTLSClient> | null = null;
  const plainWritable = new WritableStream<Uint8Array>({
    async write(chunk) {
      await tlsClient!.write(chunk);
    },
    async close() {
      // Both promises must be awaited — a bare `void promise` discards
      // rejection and crashes Node with unhandled-rejection when the
      // underlying stream is already closed. Surface teardown errors via
      // a debug log so genuine bugs aren't silenced, but never let one
      // mask the close itself (peer already gone is normal here).
      try { await tlsClient?.end(); } catch (e) { logTlsTeardownError(e); }
      try { await writer.close(); } catch (e) { logTlsTeardownError(e); }
    },
    async abort(reason) {
      try { await tlsClient?.end(); } catch (e) { logTlsTeardownError(e); }
      try { await writer.abort(reason); } catch (e) { logTlsTeardownError(e); }
    },
  });

  // Resolve when the handshake succeeds; reject on TLS-end or error before then.
  let handshakeResolve!: () => void;
  let handshakeReject!: (e: unknown) => void;
  const handshakeDone = new Promise<void>((resolve, reject) => {
    handshakeResolve = resolve;
    handshakeReject = reject;
  });
  // Register a sink for the rejection so it never lands as an unhandled
  // rejection if the pump's transport-EOF / abort path rejects before the
  // outer `await handshakeDone` (further down) attaches its own handler.
  // The real consumer of the rejection is still the await — this catch is
  // a passive observer.
  handshakeDone.catch(() => { /* main handler is the await below */ });

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
    try { plainController?.close(); } catch { /* already closed/errored */ }
  };
  const safeError = (error: unknown): void => {
    try { plainController?.error(error); } catch { /* already closed/errored */ }
  };
  const safeEnqueue = (chunk: Uint8Array<ArrayBuffer>): void => {
    // Once `plainClosed` is set, the controller has been closed/errored by
    // a teardown path and the next reclaim-driven onApplicationData would
    // throw ERR_INVALID_STATE. The teardown reason is the source of truth
    // for the consumer; silently dropping post-close bytes here is correct.
    // BEFORE plainClosed, an enqueue throw is a real invariant violation —
    // route it through closePlain so the consumer's reader unsticks with
    // the actual error rather than hanging forever.
    if (plainClosed) return;
    try {
      plainController?.enqueue(chunk);
    } catch (err) {
      closePlain(err);
    }
  };
  const closePlain = (error?: unknown): void => {
    if (plainClosed) return;
    plainClosed = true;
    cleanupSignal();
    if (error) safeError(error);
    else safeClose();
    void writer.close().catch(logTlsTeardownError);
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
  const pump = (async () => {
    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) {
          await tlsClient?.end().catch(logTlsTeardownError);
          // Reclaim's onTlsEnd usually fires for clean close-notify, but
          // a raw transport EOF without an alert wouldn't trigger it.
          // Drive closePlain ourselves so the consumer's reader unsticks
          // when the transport simply hangs up.
          closePlain();
          return;
        }
        await tlsClient?.handleReceivedBytes(value);
      }
    } catch (e) {
      if (!handshakeOk) handshakeReject(e);
      else closePlain(e);
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();
  // Detach the pump's microtask chain from the handshake await; teardown
  // calls below cancel the reader and the pump exits via its finally.
  void pump;

  if (opts.signal) {
    const captured = opts.signal;
    const onAbort = (): void => {
      const reason = captured.reason ?? new DOMException('aborted', 'AbortError');
      if (!handshakeOk) handshakeReject(reason);
      else closePlain(reason);
      void reader.cancel(reason).catch(() => {});
    };
    captured.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = (): void => { captured.removeEventListener('abort', onAbort); };
  }

  try {
    await tlsClient.startHandshake();
    await handshakeDone;
  } catch (err) {
    cleanupSignal();
    // Handshake never completed: the reader still holds the transport.readable
    // lock and the writer holds transport.writable. Cancel both so the caller
    // can close the underlying socket cleanly without an orphaned stream lock.
    void reader.cancel(err).catch(() => {});
    try { writer.releaseLock(); } catch { /* lock already released */ }
    throw err;
  }

  return { readable: plainReadable, writable: plainWritable };
};

// Keep teardown errors visible at debug level — they're usually "peer
// already closed" but a real bug would otherwise be silenced. Gate behind
// an env flag so we don't log on Workers (where we don't want any noise on
// the hot path).
interface NodeProcessShape { env?: { FLOWAY_DEBUG_TLS?: string } }
const logTlsTeardownError = (e: unknown): void => {
  const proc = (globalThis as unknown as { process?: NodeProcessShape }).process;
  if (proc?.env?.FLOWAY_DEBUG_TLS) {
    console.debug('[userspace-tls] teardown:', e);
  }
};

const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
};
