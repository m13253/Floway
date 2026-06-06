import net from 'node:net';
import { Readable, Writable } from 'node:stream';

import type { DialedSocket, SocketDial } from '@floway-dev/platform';

// `allowHalfOpen: true` lets packages/proxy send a request body and
// half-close the write side while the upstream response body is still
// streaming back. The connect-promise pattern is required because
// net.connect() returns synchronously and the actual TCP handshake runs on
// the event loop; without the await, downstream code would write into a
// not-yet-connected socket.
export const nodeSocketDial: SocketDial = {
  async connect(host, port): Promise<DialedSocket> {
    const socket = net.connect({ host, port, allowHalfOpen: true });
    await new Promise<void>((resolve, reject) => {
      const onConnect = (): void => {
        socket.off('error', onError);
        resolve();
      };
      const onError = (err: Error): void => {
        socket.off('connect', onConnect);
        reject(err);
      };
      socket.once('connect', onConnect);
      socket.once('error', onError);
    });

    // Readable/Writable.toWeb are typed as ReadableStream<Buffer | Uint8Array>
    // in Node's lib types; at runtime each chunk is a Buffer, which IS a
    // Uint8Array, so the cast is safe.
    const readable = Readable.toWeb(socket) as ReadableStream<Uint8Array>;
    const writable = Writable.toWeb(socket) as WritableStream<Uint8Array>;

    // Listen on 'close' rather than the toWeb readable's own close signal:
    // the latter fires on read-side EOF and would resolve early whenever the
    // peer half-closes its write side.
    const closed = new Promise<void>((resolve) => {
      socket.once('close', () => resolve());
    });

    return {
      readable,
      writable,
      closed,
      close: async () => {
        socket.destroy();
        await closed;
      },
    };
  },
};
