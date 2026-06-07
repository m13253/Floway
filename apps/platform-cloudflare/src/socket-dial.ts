import { connect } from 'cloudflare:sockets';

import type { DialedSocket, SocketDial } from '@floway-dev/platform';

// `tls: true` switches to workerd's native TLS — used by HTTPS CONNECT and
// VLESS-TCP+TLS, where the outer leg to the proxy is the runtime-side cert
// chain we already trust.
export const cloudflareSocketDial: SocketDial = {
  async connect(host, port, opts): Promise<DialedSocket> {
    const socket = connect(
      { hostname: host, port },
      {
        allowHalfOpen: true,
        secureTransport: opts?.tls ? 'on' : 'off',
      },
    );
    return {
      readable: socket.readable,
      writable: socket.writable,
      close: () => socket.close(),
    };
  },
};
