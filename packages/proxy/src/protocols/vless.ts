// VLESS dialer (TCP+TLS or WebSocket+TLS transports).
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

import { ProxyDialError } from '../errors.ts';
import type { VlessTcpTlsProxyConfig, VlessWsTlsProxyConfig } from '../proxy-config.ts';
import { assertValidTargetHost, assertValidTargetPort } from '../types.ts';
import type { DialOptions, DialResult, DialTarget, DialedSocket } from '../types.ts';
import { vlessFrameOverStream } from './vless-core.ts';

// Workerd-only WebSocket surface used for the WS transport. We re-declare the
// two members we touch (`accept`, `send`) here instead of pulling
// `@cloudflare/workers-types` into the package's tsconfig — that type set
// would override the lib.dom WebSocket globally and pollute every consumer
// (including the dashboard) with workerd-specific signatures.
type WorkerdWebSocket = WebSocket & {
  accept: () => void;
};

export const dialVlessTcpTls = async (
  config: VlessTcpTlsProxyConfig,
  target: DialTarget,
  options: DialOptions,
): Promise<DialResult> => {
  // Validate the target shape ahead of socketDial.connect so a bad
  // port or non-ASCII host doesn't burn a TCP slot to the proxy server.
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS');
  // workerd handles outer TLS to the VLESS server inside connect(tls=true);
  // we can't distinguish a TCP RST from a TLS handshake failure here, so any
  // dial-time error is reported as tcp-connect.
  let socket: DialedSocket;
  try {
    socket = await options.socketDial.connect(config.host, config.port, { tls: true, signal: options.signal });
  } catch (cause) {
    throw new ProxyDialError(
      `tcp connect to ${config.host}:${config.port} failed`,
      'tcp-connect',
      { cause },
    );
  }

  try {
    return await vlessFrameOverStream(socket, config.uuid, target);
  } catch (err) {
    void socket.close().catch(() => {});
    throw err;
  }
};

// The WS path performs its TLS + WebSocket upgrade through the runtime's
// global `fetch()` (workerd hands back a `webSocket` handle on the Response),
// so it never touches `socketDial`. We narrow the parameter to the slice this
// dialer actually uses — `signal` — instead of taking the full `DialOptions`
// and silently ignoring `socketDial`. The dispatcher still passes a full
// `DialOptions`; structural typing makes the call site work unchanged.
type VlessWsDialOptions = Pick<DialOptions, 'signal'>;

export const dialVlessWsTls = async (
  config: VlessWsTlsProxyConfig,
  target: DialTarget,
  options: VlessWsDialOptions,
): Promise<DialResult> => {
  // Validate the target shape ahead of the WebSocket upgrade fetch so a
  // bad port or non-ASCII host doesn't burn a connection slot.
  assertValidTargetPort(target.port, 'VLESS');
  assertValidTargetHost(target.host, 'VLESS');
  // The WS path relies on workerd's non-standard `fetch()` behavior of
  // returning a `webSocket` handle on a 101 Response. Other runtimes
  // (Node, browsers) follow the spec and emit either a thrown TypeError
  // or a plain HTTP response, so the rest of this dialer is unreachable
  // off workerd. Reject up front rather than fail deep inside the fetch
  // with an opaque "response has no .webSocket" error.
  if (typeof (globalThis as { WebSocketPair?: unknown }).WebSocketPair === 'undefined') {
    throw new ProxyDialError(
      'VLESS-WS requires a workerd-compatible runtime where fetch() returns a webSocket on the upgrade Response',
      'config',
    );
  }
  const wsUrl = `https://${config.host}:${config.port}${config.path}`;
  let resp: Response;
  try {
    resp = await fetch(wsUrl, {
      headers: { Upgrade: 'websocket', Host: config.wsHost ?? config.host },
      signal: options.signal,
    });
  } catch (cause) {
    throw new ProxyDialError(
      `ws upgrade fetch to ${config.host}:${config.port} failed`,
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

  // The signal listener fires during the dial + handshake legs; once the
  // VLESS framing returns, response-time cancellation propagates through
  // the inner TLS layer's own signal-aware streams. Detach the listener
  // before returning so a long-lived caller signal doesn't accumulate one
  // closure per dial.
  let detachAbortListener: (() => void) | null = null;
  if (options.signal) {
    const signal = options.signal;
    const onAbort = (): void => { try { ws.close(1000, 'aborted'); } catch { /* WS already closed */ } };
    signal.addEventListener('abort', onAbort, { once: true });
    detachAbortListener = (): void => signal.removeEventListener('abort', onAbort);
    // addEventListener('abort') on an already-aborted signal does not fire,
    // so an abort that landed between fetch() resolving and this listener
    // install would otherwise be lost. Drive onAbort synchronously to close
    // that TOCTOU window.
    if (signal.aborted) onAbort();
  }

  try {
    const result = await vlessFrameOverStream(transport, config.uuid, target);
    detachAbortListener?.();
    return result;
  } catch (err) {
    detachAbortListener?.();
    try { ws.close(1011, 'dial failed'); } catch { /* WS already closed */ }
    throw err;
  }
};

// Hard cap on the queued-but-not-yet-pulled bytes from the WS. LLM responses
// rarely exceed a few MiB; 64 MiB is well past any legitimate single
// response and bounds the worst case where an upstream pushes faster than
// our inner-TLS pump pulls.
const WS_QUEUE_CAP_BYTES = 64 * 1024 * 1024;

const wsAsDuplex = (ws: WorkerdWebSocket): { readable: ReadableStream<Uint8Array>; writable: WritableStream<Uint8Array> } => {
  const buffer: Uint8Array[] = [];
  let queueSize = 0;
  let pending: ((v: { value: Uint8Array | undefined; done: boolean }) => void) | null = null;
  let closed = false;
  let errored: unknown = null;

  const failStream = (err: unknown): void => {
    errored = err;
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: undefined, done: true });
    }
  };

  const enqueue = (chunk: Uint8Array): void => {
    if (chunk.byteLength === 0) return;
    if (queueSize + chunk.byteLength > WS_QUEUE_CAP_BYTES) {
      failStream(new Error(`ws inbound queue exceeded ${WS_QUEUE_CAP_BYTES} bytes; consumer is too slow`));
      try { ws.close(1009, 'queue overflow'); } catch { /* WS already closed */ }
      return;
    }
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: chunk, done: false });
    } else {
      queueSize += chunk.byteLength;
      buffer.push(chunk);
    }
  };

  // Each onMsg fires synchronously when a frame arrives, but a binary frame
  // arrives as a Blob whose arrayBuffer() is async — without serialisation
  // two frames in quick succession can resolve out of order, scrambling the
  // byte stream feeding the inner TLS layer. Inner TLS rejects every record
  // after the first inversion as a bad MAC. Chain unwraps through `tail` so
  // enqueue order matches the WS dispatch order even when the unwraps are
  // async.
  let tail: Promise<void> = Promise.resolve();
  const onMsg = (e: MessageEvent): void => {
    const data = e.data;
    tail = tail.then(async () => {
      let chunk: Uint8Array;
      if (typeof data === 'string') chunk = new TextEncoder().encode(data);
      else if (data instanceof ArrayBuffer) chunk = new Uint8Array(data);
      else if (ArrayBuffer.isView(data)) {
        const v = data as ArrayBufferView;
        chunk = new Uint8Array(v.buffer, v.byteOffset, v.byteLength);
      } else if (data && typeof (data as Blob).arrayBuffer === 'function') {
        chunk = new Uint8Array(await (data as Blob).arrayBuffer());
      } else {
        throw new Error(`unhandled ws message data type: ${(data as object)?.constructor?.name}`);
      }
      enqueue(chunk);
    }).catch(err => {
      // Surface unwrap failures (e.g. Blob.arrayBuffer rejection) on the
      // stream rather than silently dropping the message and hanging the
      // inner reader.
      failStream(err);
    });
  };
  const onClose = (): void => {
    closed = true;
    if (pending) {
      const cb = pending;
      pending = null;
      cb({ value: undefined, done: true });
    }
  };
  const onError = (e: Event): void => {
    // ErrorEvent isn't universal in workerd; fall back to a generic label
    // rather than reading a property the runtime may not expose, then carry
    // the raw event on cause so a debug log still has the original object.
    const message = e instanceof ErrorEvent && typeof e.message === 'string'
      ? e.message
      : 'unknown WebSocket error';
    failStream(new Error(`ws error: ${message}`, { cause: e }));
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
        const chunk = buffer.shift()!;
        queueSize -= chunk.byteLength;
        controller.enqueue(chunk);
        return;
      }
      if (closed) {
        controller.close();
        return;
      }
      return new Promise<void>(resolve => {
        pending = v => {
          if (errored) controller.error(errored);
          else if (v.done) controller.close();
          else controller.enqueue(v.value!);
          resolve();
        };
      });
    },
    cancel() {
      try { ws.close(); } catch { /* WS already closed */ }
    },
  });

  const writable = new WritableStream<Uint8Array>({
    write(chunk) {
      ws.send(chunk);
    },
    close() {
      try { ws.close(); } catch { /* WS already closed */ }
    },
    abort(reason) {
      try { ws.close(1006, String(reason).slice(0, 120)); } catch { /* WS already closed */ }
    },
  });

  return { readable, writable };
};
