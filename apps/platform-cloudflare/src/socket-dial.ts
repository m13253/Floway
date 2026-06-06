import { connect } from 'cloudflare:sockets';

import type { DialedSocket, SocketDial } from '@floway-dev/platform';

// `secureTransport: 'off'` is the explicit default; we keep it explicit
// because packages/proxy runs userspace TLS on top of the raw byte stream.
export const cloudflareSocketDial: SocketDial = {
  async connect(host, port): Promise<DialedSocket> {
    const socket = connect(
      { hostname: host, port },
      { allowHalfOpen: true, secureTransport: 'off' },
    );
    return {
      readable: socket.readable,
      writable: socket.writable,
      closed: socket.closed,
      close: () => socket.close(),
    };
  },
};
