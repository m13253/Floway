import { connect } from 'cloudflare:sockets';

import type { DialedSocket, SocketDial } from '@floway-dev/platform';

// `tls: true` switches to workerd's native TLS — used by HTTPS CONNECT and
// VLESS-TCP+TLS, where the outer leg to the proxy is the runtime-side cert
// chain we already trust.
//
// AbortSignal handling: cloudflare:sockets doesn't accept a signal on connect
// itself, so we honour it ourselves. A pre-aborted signal short-circuits
// before opening a socket; once opened, an abort closes the socket — the
// proxy runners observe that as a read/write rejection. The listener is
// detached on close() and on natural socket close so a long-lived caller
// signal doesn't accumulate one pinned closure per dial.
//
// We `await socket.opened` before resolving so a TLS handshake error or
// connect-refused surfaces as a connect-time rejection (with `cause`)
// rather than as an opaque first-read failure later.
// Convert a caller-supplied abort signal's reason into a thrown AbortError.
// Preserve a structured Error reason as-is so its stack/cause survives;
// stringify only when the reason is a primitive or absent.
const throwAbort = (signal: AbortSignal): never => {
  const reason = signal.reason;
  if (reason instanceof Error) throw reason;
  throw new DOMException(String(reason ?? 'aborted'), 'AbortError');
};

export const cloudflareSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) throwAbort(opts.signal);
    const socket = connect(
      { hostname: host, port },
      {
        allowHalfOpen: true,
        secureTransport: opts?.tls ? 'on' : 'off',
      },
    );
    // Idempotent close — the runtime can reject `socket.close()` on an already
    // errored socket, and a stalled close promise must not block teardown.
    const safeClose = async (): Promise<void> => {
      try { await socket.close(); } catch { /* already closed/errored */ }
    };
    let abortListener: (() => void) | null = null;
    const removeAbortListener = (): void => {
      if (abortListener && opts?.signal) {
        opts.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
    if (opts?.signal) {
      const signal = opts.signal;
      abortListener = (): void => { void safeClose(); };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    // Drop the abort listener on natural close as well, so a signal that
    // outlives this dial doesn't accumulate stale closures. The catch is
    // explicit so an unhandled-rejection observer doesn't see the
    // socket.closed rejection that fires on every connect failure.
    void socket.closed.catch(() => { /* errors observed via opened/streams */ }).finally(removeAbortListener);

    try {
      await socket.opened;
    } catch (cause) {
      removeAbortListener();
      await safeClose();
      // If the failure was caused by the caller's abort, surface as
      // AbortError (preserving the original reason if it was an Error)
      // so the dial chain's AbortError fast-path classifies it correctly
      // instead of treating it as a generic connect failure.
      if (opts?.signal?.aborted) throwAbort(opts.signal);
      throw new Error(`dial ${host}:${port} failed`, { cause });
    }

    if (opts?.signal?.aborted) {
      await safeClose();
      throwAbort(opts.signal);
    }

    return {
      readable: socket.readable,
      writable: socket.writable,
      close: async () => {
        removeAbortListener();
        await safeClose();
      },
    };
  },
};
