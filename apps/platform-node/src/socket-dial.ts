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
export const nodeSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    // tls.connect does not accept allowHalfOpen — TLS has its own
    // close-notify so half-open is not meaningful at this layer.
    const socket = opts?.tls
      ? tls.connect({ host, port, servername: host })
      : net.connect({ host, port, allowHalfOpen: true });
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
    socket.on('error', () => {});

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
