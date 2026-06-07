// HTTP CONNECT proxy client.
//
// Native `socket.startTls()` is broken on Workers production edge after any
// pre-handshake bytes are exchanged (workerd #2712). We therefore:
//   1. Open a plain TCP socket to the proxy (or, if the proxy is HTTPS, ask
//      the runtime to wrap the proxy hop in TLS via the dial `tls` option).
//   2. Write CONNECT + auth, parse 2xx response.
//   3. Hand the post-CONNECT byte stream to our userspace TLS for the upstream
//      handshake. This avoids `startTls()` entirely.

import { ProxyDialError } from '../errors.js';
import { runHttp1 } from '../http1.js';
import { userspaceTls, type TlsStream } from '../tls.js';
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js';
import { type DialedSocket, getSocketDial } from '@floway-dev/platform';

export interface HttpConnectOptions {
  proxyHost: string;
  proxyPort: number;
  proxyTls: boolean;
  auth?: { username: string; password: string };
  target: TargetSpec;
  signal?: AbortSignal;
}

export async function runHttpConnect(opts: HttpConnectOptions): Promise<Response> {
  const { proxyHost, proxyPort, proxyTls, auth, target, signal } = opts;
  // workerd performs the outer TLS handshake inside connect() when tls=true,
  // so a TLS handshake error to the proxy surfaces as a connect failure here
  // — we can't tell the two apart from this layer.
  let socket: DialedSocket;
  try {
    socket = await getSocketDial().connect(proxyHost, proxyPort, { tls: proxyTls, signal });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${proxyHost}:${proxyPort} failed`,
      'tcp-connect',
      { cause },
    );
  }

  try {
    return await runHttpConnectInner(socket, auth, target, signal);
  } catch (err) {
    // Any throw past `connect()` means the runner won't be returning a
    // Response — the response-body lifecycle that normally drives socket
    // teardown never starts. Close the socket explicitly so we don't leak
    // an FD on the Node side / a connection slot on Workers.
    void socket.close().catch(() => {});
    throw err;
  }
}

async function runHttpConnectInner(
  socket: DialedSocket,
  auth: { username: string; password: string } | undefined,
  target: TargetSpec,
  signal: AbortSignal | undefined,
): Promise<Response> {
  const writer = socket.writable.getWriter();
  const enc = new TextEncoder();
  const lines = [
    `CONNECT ${target.dialHost}:${target.port} HTTP/1.1`,
    `Host: ${target.dialHost}:${target.port}`,
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
  // response and forward the rest to a downstream stream that we hand to TLS.

  const { readable: postConnect, writable: forward } = new TransformStream<Uint8Array, Uint8Array>();
  const fwdWriter = forward.getWriter();

  // The peel pump runs in the background after we return a Response — body-
  // stream errors are surfaced via fwdWriter.abort. On the failure path
  // (inner-tls or runHttp1 throws BEFORE we return), the outer try/catch in
  // runHttpConnect closes the socket and the pump's reader.read() rejects;
  // we attach a noop terminal handler immediately so a pending rejection
  // never escapes as an unhandled rejection.
  // Cap the CONNECT-response accumulation. A hostile or broken proxy that
  // streams data without ever emitting the double-CRLF would otherwise grow
  // `buf` until the Worker's heap cap (~128 MiB) kills the request. 64 KiB
  // is two orders of magnitude over the real CONNECT-response size and
  // still bounds the worst case.
  const HEADER_BUFFER_CAP = 64 * 1024;
  const peelDone = (async () => {
    const reader = socket.readable.getReader();
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
  })();
  // Always-on terminal handler routes peel errors into the forward stream
  // so the consumer (userspace TLS / runHttp1) sees them as transport
  // failures, and prevents an unhandled rejection on the failure path.
  peelDone.catch(e => { fwdWriter.abort(e).catch(() => {}); });

  // Now wrap the post-CONNECT byte stream with userspace TLS for the upstream.
  if (target.tls) {
    const transport = { readable: postConnect, writable: socket.writable };
    let tls: TlsStream;
    try {
      tls = await userspaceTls(transport, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target), signal });
    } catch (cause) {
      // peelDone errors flow through the TransformStream into userspaceTls,
      // surfacing as a handshake-time rejection here. Preserve the original
      // ProxyDialError so the dial layer's stage-aware backoff classifies a
      // CONNECT 4xx as `proxy-handshake` rather than mis-tagging it as
      // `inner-tls`.
      if (cause instanceof ProxyDialError) throw cause;
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return await runHttp1(tls, target);
  } else {
    // Plain HTTP upstream — the post-CONNECT stream is the upstream socket.
    return await runHttp1({ readable: postConnect, writable: socket.writable }, target);
  }
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
}

function findDoubleCrlf(buf: Uint8Array): number {
  for (let i = 0; i + 3 < buf.byteLength; i++) {
    if (buf[i] === 0x0d && buf[i + 1] === 0x0a && buf[i + 2] === 0x0d && buf[i + 3] === 0x0a) return i;
  }
  return -1;
}
