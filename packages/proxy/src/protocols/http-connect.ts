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
}

export async function runHttpConnect(opts: HttpConnectOptions): Promise<Response> {
  const { proxyHost, proxyPort, proxyTls, auth, target } = opts;
  // workerd performs the outer TLS handshake inside connect() when tls=true,
  // so a TLS handshake error to the proxy surfaces as a connect failure here
  // — we can't tell the two apart from this layer.
  let socket: DialedSocket;
  try {
    socket = await getSocketDial().connect(proxyHost, proxyPort, { allowHalfOpen: true, tls: proxyTls });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${proxyHost}:${proxyPort} failed`,
      'tcp-connect',
      { cause },
    );
  }

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

  const peelDone = (async () => {
    const reader = socket.readable.getReader();
    let buf = new Uint8Array(0);
    while (true) {
      const idx = findDoubleCrlf(buf);
      if (idx >= 0) {
        const head = new TextDecoder().decode(buf.subarray(0, idx));
        const m = /^HTTP\/1\.[01] (\d{3}) (.*)\r\n/.exec(`${head}\r\n`);
        if (!m) throw new ProxyDialError(`CONNECT bad status line: ${JSON.stringify(head.split('\r\n')[0])}`, 'proxy-handshake');
        const status = parseInt(m[1]!, 10);
        if (status < 200 || status >= 300) {
          throw new ProxyDialError(`CONNECT replied ${m[1]} ${m[2]}`, 'proxy-handshake');
        }
        const trailing = buf.subarray(idx + 4);
        if (trailing.byteLength) await fwdWriter.write(copy(trailing));
        // Pump the rest of the socket into the forward stream
        while (true) {
          const r = await reader.read();
          if (r.done) {
            try { await fwdWriter.close(); } catch {}
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
    }
  })().catch(e => {
    fwdWriter.abort(e).catch(() => {});
    throw e;
  });

  // Now wrap the post-CONNECT byte stream with userspace TLS for the upstream.
  if (target.tls) {
    const transport = { readable: postConnect, writable: socket.writable };
    let tls: TlsStream;
    try {
      tls = await userspaceTls(transport, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target) });
    } catch (cause) {
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    const resp = await runHttp1(tls, target);
    // Run peelDone in the background; if it throws after handshake the body
    // stream will surface the error.
    peelDone.catch(() => {});
    return resp;
  } else {
    // Plain HTTP upstream — the post-CONNECT stream is the upstream socket.
    const resp = await runHttp1({ readable: postConnect, writable: socket.writable }, target);
    peelDone.catch(() => {});
    return resp;
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
