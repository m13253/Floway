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

import { base64EncodeBytes, concat, copy, findDoubleCrlf, utf8Bytes } from '../bytes.ts';
import { ProxyDialError } from '../errors.ts';
import type { HttpProxyConfig } from '../proxy-config.ts';
import { assertValidTargetHost, assertValidTargetPort } from '../types.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { STATUS_LINE } from '@floway-dev/http';

export const dialHttpConnect = async (
  config: HttpProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  assertValidTargetPort(target.port, 'CONNECT');
  // The CONNECT request-line and the Host header both serialize the
  // target host as wire bytes. RFC 9110 §5.4 + §3.4 expect a valid
  // ASCII uri-host; punycode IDN labels happen at the gateway layer
  // before they reach this dialer. Reject up-front so we don't straddle
  // Latin-1 / UTF-8 framing on the wire and so we never burn a TCP
  // connection on a request the proxy is guaranteed to reject.
  assertValidTargetHost(target.host, 'CONNECT');

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
  const lines = [
    `CONNECT ${target.host}:${target.port} HTTP/1.1`,
    `Host: ${target.host}:${target.port}`,
    'Proxy-Connection: keep-alive',
  ];
  if (auth) {
    // RFC 7617 §2.1 defaults the credential charset to UTF-8. `btoa` on a
    // JS string Latin-1-encodes each code unit, so a password byte in
    // U+0080..U+00FF would go on the wire as that single Latin-1 byte
    // and a code point > U+00FF would throw InvalidCharacterError mid-
    // dial. Encode to UTF-8 bytes first, then base64.
    const token = base64EncodeBytes(utf8Bytes(`${auth.username}:${auth.password}`));
    lines.push(`Proxy-Authorization: Basic ${token}`);
  }
  await writer.write(utf8Bytes(`${lines.join('\r\n')}\r\n\r\n`));
  writer.releaseLock();

  // Peel the CONNECT response off the socket reader, then mint a fresh
  // readable via a TransformStream and hand it to the orchestrator. Trailing
  // bytes from the same read that completes the headers, plus everything
  // the socket reader sees afterwards, flow into the forwarded stream so
  // the post-CONNECT consumer (userspace TLS / fetchOnStream) starts from
  // a clean byte boundary.

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
          const statusLine = head.split('\r\n')[0]!;
          const m = STATUS_LINE.exec(statusLine);
          if (!m) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(statusLine)}`, 'proxy-handshake');
          const status = parseInt(m[1]!, 10);
          if (status < 200 || status >= 300) {
            throw new ProxyDialError(`CONNECT replied ${m[1]} ${m[2]!}`.trimEnd(), 'proxy-handshake');
          }
          const trailing = buf.subarray(idx + 4);
          if (trailing.byteLength) await fwdWriter.write(copy(trailing));
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
        buf = concat(buf, value);
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
