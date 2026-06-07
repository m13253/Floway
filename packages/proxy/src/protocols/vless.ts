// VLESS client (TCP+TLS or WebSocket+TLS transports).
//
// VLESS spec (https://xtls.github.io/development/protocols/vless.html):
//   ver[1=0x00] | UUID[16] | addonsLen[1] | addons[N=0]
//     | cmd[1] (0x01 TCP, 0x02 UDP)
//     | port[2 BE]
//     | atyp[1] (0x01 v4, 0x02 domain (length-prefixed), 0x03 v6)
//     | addr[var]
//     | payload…
//
// The reply prefix from the server is `ver[1] | addonsLen[1] | addons[M]`,
// followed by transparent payload. We parse and discard the reply prefix.

import { ProxyDialError } from '../errors.js';
import { runHttp1 } from '../http1.js';
import { userspaceTls, type TlsStream } from '../tls.js';
import { type TargetSpec, resolveTlsSni, resolveTlsVerifyHost } from '../types.js';
import { type DialedSocket, getSocketDial } from '@floway-dev/platform';

// Workerd-only WebSocket surface used for the WS transport. We re-declare the
// two members we touch (`accept`, `send`) here instead of pulling
// `@cloudflare/workers-types` into the package's tsconfig — that type set
// would override the lib.dom WebSocket globally and pollute every consumer
// (including the dashboard) with workerd-specific signatures.
type WorkerdWebSocket = WebSocket & {
  accept: () => void;
};

export interface VlessTcpTlsOptions {
  serverHost: string;
  serverPort: number;
  uuid: string;
  target: TargetSpec;
}

export async function runVlessTcpTls(opts: VlessTcpTlsOptions): Promise<Response> {
  const { serverHost, serverPort, uuid, target } = opts;

  // workerd handles outer TLS to the VLESS server inside connect(tls=true);
  // we can't distinguish a TCP RST from a TLS handshake failure here, so any
  // dial-time error is reported as tcp-connect.
  let socket: DialedSocket;
  try {
    socket = await getSocketDial().connect(serverHost, serverPort, { tls: true });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${serverHost}:${serverPort} failed`,
      'tcp-connect',
      { cause },
    );
  }

  const header = buildVlessHeader(uuid, target);
  const writer = socket.writable.getWriter();
  await writer.write(header);
  writer.releaseLock();

  // Strip the VLESS reply prefix lazily — it only arrives after the upstream
  // sees our first inner-payload bytes (e.g. TLS ClientHello).
  const stripped = stripVlessReplyPrefix(socket.readable);

  if (target.tls) {
    let tls: TlsStream;
    try {
      tls = await userspaceTls({ readable: stripped, writable: socket.writable }, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target) });
    } catch (cause) {
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return await runHttp1(tls, target);
  } else {
    return await runHttp1({ readable: stripped, writable: socket.writable }, target);
  }
}

export interface VlessWsTlsOptions {
  serverHost: string;
  serverPort: number;
  uuid: string;
  path: string;
  target: TargetSpec;
}

export async function runVlessWsTls(opts: VlessWsTlsOptions): Promise<Response> {
  const { serverHost, serverPort, uuid, path, target } = opts;

  // Use Worker fetch() to do the WS upgrade — workerd handles outer TLS for us.
  const wsUrl = `https://${serverHost}:${serverPort}${path}`;
  let resp: Response;
  try {
    resp = await fetch(wsUrl, {
      headers: { Upgrade: 'websocket', Host: serverHost },
    });
  } catch (cause) {
    throw new ProxyDialError(
      `ws upgrade fetch to ${serverHost}:${serverPort} failed`,
      'tcp-connect',
      { cause },
    );
  }
  if (resp.status !== 101) {
    throw new ProxyDialError(`VLESS-WS upgrade replied ${resp.status} ${resp.statusText}`, 'proxy-handshake');
  }
  const ws = (resp as Response & { webSocket?: WorkerdWebSocket }).webSocket;
  if (!ws) throw new ProxyDialError('VLESS-WS: response has no .webSocket', 'proxy-handshake');
  // Wrap the WebSocket as a duplex byte stream — listeners attach before
  // ws.accept() so we don't miss any early messages.
  const transport = wsAsDuplex(ws);
  ws.accept();

  // Write the VLESS header as the first message on the WS
  const header = buildVlessHeader(uuid, target);
  const wsWriter = transport.writable.getWriter();
  await wsWriter.write(header);
  wsWriter.releaseLock();

  // Strip reply prefix lazily
  const stripped = stripVlessReplyPrefix(transport.readable);

  if (target.tls) {
    let tls: TlsStream;
    try {
      tls = await userspaceTls({ readable: stripped, writable: transport.writable }, { host: resolveTlsSni(target), verifyHost: resolveTlsVerifyHost(target) });
    } catch (cause) {
      throw new ProxyDialError('inner tls handshake to upstream failed', 'inner-tls', { cause });
    }
    return await runHttp1(tls, target);
  } else {
    return await runHttp1({ readable: stripped, writable: transport.writable }, target);
  }
}

function buildVlessHeader(uuid: string, target: TargetSpec): Uint8Array {
  const enc = new TextEncoder();
  const dom = enc.encode(target.dialHost);
  if (dom.byteLength > 255) throw new ProxyDialError('VLESS: hostname too long', 'proxy-handshake');
  const uuidBytes = parseUuid(uuid);
  const header = new Uint8Array(1 + 16 + 1 + 0 + 1 + 2 + 1 + 1 + dom.byteLength);
  let off = 0;
  header[off++] = 0x00;
  header.set(uuidBytes, off); off += 16;
  header[off++] = 0x00;
  header[off++] = 0x01;
  header[off++] = (target.port >> 8) & 0xff;
  header[off++] = target.port & 0xff;
  header[off++] = 0x02;
  header[off++] = dom.byteLength;
  header.set(dom, off); off += dom.byteLength;
  return header;
}

function parseUuid(s: string): Uint8Array {
  const hex = s.replace(/-/g, '');
  if (hex.length !== 32) throw new Error('bad UUID');
  const out = new Uint8Array(16);
  for (let i = 0; i < 16; i++) out[i] = parseInt(hex.substr(i * 2, 2), 16);
  return out;
}

function stripVlessReplyPrefix(
  source: ReadableStream<Uint8Array>,
): ReadableStream<Uint8Array> {
  // The reply prefix is sent only after the upstream responds. If we eagerly
  // wait for it before the inner protocol writes its first bytes (e.g. TLS
  // ClientHello), we deadlock — the upstream won't speak until we've sent
  // the inner request. So we strip lazily on first pull.
  const reader = source.getReader();
  let stripped = false;
  let buf = new Uint8Array(0);

  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!stripped) {
        while (buf.byteLength < 2) {
          const r = await reader.read();
          if (r.done) {
            controller.error(new ProxyDialError('VLESS reply: EOF before prefix', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        const addonsLen = buf[1]!;
        while (buf.byteLength < 2 + addonsLen) {
          const r = await reader.read();
          if (r.done) {
            controller.error(new ProxyDialError('VLESS reply: EOF in addons', 'proxy-handshake'));
            return;
          }
          buf = concat(buf, r.value);
        }
        stripped = true;
        const remainder = copy(buf.subarray(2 + addonsLen));
        if (remainder.byteLength) {
          controller.enqueue(remainder);
          return;
        }
      }
      const r = await reader.read();
      if (r.done) controller.close();
      else controller.enqueue(copy(r.value));
    },
    cancel() {
      reader.cancel().catch(() => {});
    },
  });
}

function wsAsDuplex(ws: WorkerdWebSocket): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } {
  const buffer: Uint8Array[] = [];
  let pending: ((v: { value: Uint8Array | undefined; done: boolean }) => void) | null = null;
  let closed = false;
  let errored: unknown = null;

  const enqueue = (chunk: Uint8Array) => {
    if (chunk.byteLength === 0) return;
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: chunk, done: false });
    } else {
      buffer.push(chunk);
    }
  };

  const onMsg = (e: MessageEvent) => {
    void (async () => {
      const data = e.data;
      let chunk: Uint8Array;
      if (typeof data === 'string') chunk = new TextEncoder().encode(data);
      else if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      } else if (data && typeof (data as Blob).arrayBuffer === 'function') {
        chunk = new Uint8Array(await (data as Blob).arrayBuffer());
      } else {
        console.log(`[ws] unhandled message data type: ${(data as object)?.constructor?.name}`);
        return;
      }
      enqueue(chunk);
    })();
  };
  const onClose = () => {
    closed = true;
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: undefined, done: true });
    }
  };
  const onError = (e: Event) => {
    errored = new Error(`ws error: ${(e as ErrorEvent).message ?? 'unknown'}`);
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: undefined, done: true });
    }
  };

  ws.addEventListener('message', onMsg);
  ws.addEventListener('close', onClose);
  ws.addEventListener('error', onError);

  const readable = new ReadableStream<Uint8Array>({
    pull(controller) {
      if (errored) {
        controller.error(errored);
        return;
      }
      if (buffer.length) {
        controller.enqueue(buffer.shift()!);
        return;
      }
      if (closed) {
        controller.close();
        return;
      }
      return new Promise<void>(resolve => {
        pending = v => {
          if (v.done) controller.close();
          else controller.enqueue(v.value!);
          resolve();
        };
      });
    },
    cancel() {
      try { ws.close(); } catch {}
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      ws.send(chunk);
    },
    close() {
      try { ws.close(); } catch {}
    },
    abort(reason) {
      try { ws.close(1006, String(reason).slice(0, 120)); } catch {}
    },
  });

  return { readable, writable };
}

function concat(a: Uint8Array, b: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(a.byteLength + b.byteLength);
  r.set(a, 0);
  r.set(b, a.byteLength);
  return r;
}

function copy(u: Uint8Array): Uint8Array<ArrayBuffer> {
  const r = new Uint8Array(u.byteLength);
  r.set(u);
  return r;
}
