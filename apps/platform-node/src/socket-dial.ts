import net from 'node:net';
import { Readable, Writable } from 'node:stream';
import tls from 'node:tls';

import type { DialedSocket, SocketDial } from '@floway-dev/platform';

// The connect-promise pattern is required because node:net / node:tls connect
// synchronously and the actual handshake runs on the event loop; without the
// await, downstream code would write into a not-yet-connected socket.
//
// `tls: true` switches to node:tls — the SNI and cert-verify name both
// default to `host`. Used by the proxy library's outer-TLS legs (HTTPS
// CONNECT, VLESS-TCP+TLS) where the runtime's native TLS is faster than
// userspace TLS.
//
// `signal` is honoured at three layers: (1) pre-connect short-circuit, (2)
// node:net / node:tls native abort during the connect handshake, (3) post-
// connect socket.destroy() so subsequent reads/writes reject.
export const nodeSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    if (opts?.signal?.aborted) {
      const reason = opts.signal.reason;
      if (reason instanceof Error) throw reason;
      throw new DOMException(String(reason ?? 'aborted'), 'AbortError');
    }
    // node:net / node:tls accept `signal` natively; passing it lets the
    // runtime tear down a connect that has not yet fired 'connect' /
    // 'secureConnect' without us having to race anything ourselves.
    // We don't request `allowHalfOpen` on TLS — close-notify makes
    // half-close fragile across TLS 1.3 implementations.
    //
    // tls.connect honours `signal` at runtime but @types/node hasn't yet
    // surfaced it on tls.ConnectionOptions; @ts-expect-error makes the
    // type lag visible (the line will start failing the day the type is
    // added) so we can drop the suppression instead of letting an `as`
    // cast silently absorb future shape changes.
    const signal = opts?.signal;
    const socket = opts?.tls
      // @ts-expect-error – tls.ConnectionOptions does not yet declare `signal` in @types/node, but tls.connect accepts and honours it at runtime.
      ? tls.connect({ host, port, servername: host, signal })
      : net.connect({ host, port, allowHalfOpen: true, signal });
    const readyEvent = opts?.tls ? 'secureConnect' : 'connect';
    await new Promise<void>((resolve, reject) => {
      const onReady = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off(readyEvent, onReady);
        reject(err);
      };
      socket.once(readyEvent, onReady);
      socket.once('error', onError);
    });

    // toWeb's Buffer | Uint8Array typing is wider than runtime — chunks are Buffers, which are Uint8Arrays.
    const readable = Readable.toWeb(socket) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(socket) as WritableStream<Uint8Array>;

    // Listen on 'close' rather than the toWeb readable's own close signal:
    // the latter fires on read-side EOF and would resolve early whenever the
    // peer half-closes its write side.
    const closed = new Promise<void>(resolve => {
      socket.once('close', () => resolve());
    });

    // After the connect handshake resolves, the dial-time onError listener is
    // gone. Without a permanent 'error' listener Node escalates any
    // post-connect socket error to uncaughtException and crashes the process.
    // The error itself surfaces via the readable/writable streams the proxy
    // runners drive — this listener exists purely to keep Node from crashing.
    // Surface the error at debug level when FLOWAY_DEBUG_SOCKET is set so
    // post-teardown resets stay observable to operators.
    socket.on('error', err => {
      if (process.env.FLOWAY_DEBUG_SOCKET) {

        console.debug('[socket-dial] post-connect error:', err);
      }
    });

    if (opts?.signal) {
      const captured = opts.signal;
      const onAbort = (): void => { socket.destroy(); };
      captured.addEventListener('abort', onAbort, { once: true });
      // Drop the listener on natural socket close so a long-lived caller
      // signal (e.g. a request controller shared across dials) doesn't
      // accumulate one closure per dial pinning the destroyed socket.
      socket.once('close', () => {
        captured.removeEventListener('abort', onAbort);
      });
    }

    return {
      readable,
      writable,
      close: async () => {
        socket.destroy();
        await closed;
      },
    };
  },
};
