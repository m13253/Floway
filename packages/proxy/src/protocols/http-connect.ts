// HTTP CONNECT proxy dialer.
//
// Native `socket.startTls()` is broken on Workers production edge after any
// pre-handshake bytes are exchanged (workerd #2712). We therefore:
//   1. Open a plain TCP socket to the proxy (or, if the proxy is HTTPS, ask
//      the runtime to wrap the proxy hop in TLS via the dial `tls` option).
//   2. Write CONNECT + auth, parse 2xx response.
//   3. Hand the post-CONNECT byte stream back to the orchestrator, which
//      layers userspace TLS for the upstream's HTTPS handshake. This avoids
//      `startTls()` entirely.

import { ProxyDialError } from '../errors.ts';
import type { HttpProxyConfig } from '../proxy-config.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';

export const dialHttpConnect = async (
  config: HttpProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  const auth = config.username !== undefined
    ? { username: config.username, password: config.password ?? '' }
    : undefined;

  // workerd performs the outer TLS handshake inside connect() when tls=true,
  // so a TLS handshake error to the proxy surfaces as a connect failure here
  // — we can't tell the two apart from this layer.
  let socket: DialedSocket;
  try {
    socket = await options.socketDial.connect(config.host, config.port, { tls: config.tls, signal: options.signal });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${config.host}:${config.port} failed`,
      'tcp-connect',
      { cause },
    );
  }

  try {
    return await dialHttpConnectInner(socket, auth, target);
  } catch (err) {
    // Any throw past `connect()` means the dial won't be returning a
    // stream — the response-body lifecycle that normally drives socket
    // teardown never starts. Close the socket explicitly so we don't leak
    // an FD on the Node side / a connection slot on Workers.
    void socket.close().catch(() => {});
    throw err;
  }
};

const dialHttpConnectInner = async (
  socket: DialedSocket,
  auth: { username: string; password: string } | undefined,
  target: DialTarget,
): Promise<DialResult> => {
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const lines = [
    `CONNECT ${target.host}:${target.port} HTTP/1.1`,
    `Host: ${target.host}:${target.port}`,
    'Proxy-Connection: keep-alive',
  ];
  if (auth) {
    const token = btoa(`${auth.username}:${auth.password}`);
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  await writer.write(enc.encode(`${lines.join('\r\n')}\r\n\r\n`));
  writer.releaseLock();

  // Drain the CONNECT response from the readable. We can't use getReader here
  // because we'd then have to release/replay any buffered post-header bytes
  // into a brand-new stream. Use a TransformStream to peel off the CONNECT
  // response and forward the rest to a downstream stream that we hand back
  // to the orchestrator.

  const { readable: postConnect, writable: forward } = new TransformStream<Uint8Array, Uint8Array>();
  const fwdWriter = forward.getWriter();

  // Cap the CONNECT-response accumulation. A hostile or broken proxy that
  // streams data without ever emitting the double-CRLF would otherwise grow
  // `buf` until the Worker's heap cap (~128 MiB) kills the request. 64 KiB
  // is two orders of magnitude over the real CONNECT-response size and
  // still bounds the worst case.
  const HEADER_BUFFER_CAP = 64 * 1024;
  const reader = socket.readable.getReader();
  const peelDone = (async () => {
    try {
      let buf = new Uint8Array(0);
      while (true) {
        const idx = findDoubleCrlf(buf);
        if (idx >= 0) {
          const head = new TextDecoder().decode(buf.subarray(0, idx));
          const m = /^HTTP\/1\.[01] (\d{3})(?: (.*))?\r\n/.exec(`${head}\r\n`);
          if (!m) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(head.split('\r\n')[0])}`, 'proxy-handshake');
          const status = parseInt(m[1]!, 10);
          if (status < 200 || status >= 300) {
            throw new ProxyDialError(`CONNECT replied ${m[1]} ${m[2] ?? ''}`.trimEnd(), 'proxy-handshake');
          }
          const trailing = buf.subarray(idx + 4);
          if (trailing.byteLength) await fwdWriter.write(copy(trailing));
          // Pump the rest of the socket into the forward stream
          while (true) {
            const r = await reader.read();
            if (r.done) {
              try { await fwdWriter.close(); } catch { /* fwd already closed */ }
              return;
            }
            await fwdWriter.write(copy(r.value));
          }
        }
        const { value, done } = await reader.read();
        if (done) throw new ProxyDialError(`CONNECT: EOF before status (${buf.byteLength} bytes read)`, 'proxy-handshake');
        const next = new Uint8Array(buf.byteLength + value.byteLength);
        next.set(buf, 0);
        next.set(value, buf.byteLength);
        buf = next;
        if (buf.byteLength > HEADER_BUFFER_CAP) {
          throw new ProxyDialError(`CONNECT response exceeded ${HEADER_BUFFER_CAP} bytes without a header terminator`, 'proxy-handshake');
        }
      }
    } finally {
      try { reader.releaseLock(); } catch { /* lock already released */ }
    }
  })();
  // Always-on terminal handler routes peel errors into the forward stream
  // so the orchestrator's next consumer (userspace TLS / fetchOnStream)
  // sees them as transport failures, and prevents an unhandled rejection
  // on the failure path. The outer dial-time try/catch has already exited
  // by the time this fires, so we ALSO close the socket here — the
  // orchestrator only holds wrapper streams and has no way to reach the
  // raw fd otherwise.
  peelDone.catch(e => {
    fwdWriter.abort(e).catch(() => {});
    void socket.close().catch(() => {});
  });

  return { readable: postConnect, writable: socket.writable };
};

const copy = (u: Uint8Array): Uint8Array<ArrayBuffer> => {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
};

const findDoubleCrlf = (buf: Uint8Array): number => {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
};
