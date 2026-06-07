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
// detached on close() so a long-lived caller signal doesn't accumulate one
// pinned closure per dial.
export const cloudflareSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) {
      throw new DOMException(String(opts.signal.reason ?? 'aborted'), 'AbortError');
    }
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
    if (opts?.signal) {
      const signal = opts.signal;
      abortListener = (): void => { void safeClose(); };
      signal.addEventListener('abort', abortListener, { once: true });
    }
    const removeAbortListener = (): void => {
      if (abortListener && opts?.signal) {
        opts.signal.removeEventListener('abort', abortListener);
        abortListener = null;
      }
    };
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
