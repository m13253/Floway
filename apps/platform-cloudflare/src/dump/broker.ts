import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal namespace surface from the worker's BROADCAST_DO binding. Matches
// the subset of `DurableObjectNamespace` we actually call — keeps this file
// off the workers-types dependency.
export interface BroadcastNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BroadcastStub;
}

interface BroadcastStub {
  // Direct RPC method invocation — see BroadcastDO for the contract.
  broadcast(payload: string): Promise<void>;
  closeAll(reason: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

// The wire framing convention this broker chooses to layer over the actor's
// content-agnostic `broadcast(string)`. The actor never inspects the
// payload; the dump producer and dump subscriber are the only sides that
// know about `event: 'appended'` and the `DumpMetadata` shape.
const APPENDED_EVENT = 'appended';
interface AppendedFrame {
  event: typeof APPENDED_EVENT;
  data: DumpMetadata;
}

const encodeFrame = (meta: DumpMetadata): string =>
  JSON.stringify({ event: APPENDED_EVENT, data: meta } satisfies AppendedFrame);

const decodeFrame = (data: string | ArrayBuffer): AppendedFrame => {
  const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
  const parsed = JSON.parse(text) as { event: unknown; data: unknown };
  if (parsed.event !== APPENDED_EVENT) {
    throw new Error(`broadcast frame had unexpected event ${String(parsed.event)}`);
  }
  return { event: APPENDED_EVENT, data: parsed.data as DumpMetadata };
};

export class DurableObjectDumpBroker implements DumpBroker {
  constructor(private readonly namespace: BroadcastNamespace) {}

  private stub(keyId: string): BroadcastStub {
    return this.namespace.get(this.namespace.idFromName(keyId));
  }

  async publish(keyId: string, meta: DumpMetadata): Promise<void> {
    await this.stub(keyId).broadcast(encodeFrame(meta));
  }

  async notifyDisabled(keyId: string): Promise<void> {
    await this.stub(keyId).closeAll('dump retention disabled');
  }

  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata> {
    return iterateFromBroadcastSocket(this.stub(keyId), signal);
  }
}

// Drive an async iterator from the WS the broadcast actor returns. The
// socket open + the message listener attach run eagerly here — before the
// caller awaits the iterator's first `.next()` — so a broadcast that races
// against the iterator drain still buffers into the queue and lands on the
// next read.
const iterateFromBroadcastSocket = (stub: BroadcastStub, signal: AbortSignal): AsyncIterable<DumpMetadata> => {
  const queue: DumpMetadata[] = [];
  let resolveNext: ((value: IteratorResult<DumpMetadata>) => void) | null = null;
  let pendingError: unknown = null;
  let closed = false;

  const deliver = (value: IteratorResult<DumpMetadata>): void => {
    if (resolveNext) {
      const r = resolveNext;
      resolveNext = null;
      r(value);
    } else if (!value.done) {
      queue.push(value.value);
    }
  };

  const openPromise = (async (): Promise<WebSocket> => {
    const response = await stub.fetch(new Request('https://broadcast.do/subscribe', {
      headers: { Upgrade: 'websocket' },
    }));
    if (response.status !== 101) {
      throw new Error(`BroadcastDO subscribe returned HTTP ${response.status} instead of 101`);
    }
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    if (!socket) throw new Error('BroadcastDO returned 101 without a webSocket');
    socket.accept();
    socket.addEventListener('message', event => {
      if (closed) return;
      try {
        const frame = decodeFrame(event.data as string | ArrayBuffer);
        deliver({ value: frame.data, done: false });
      } catch (err) {
        pendingError = err;
        void closeAndEnd();
      }
    });
    socket.addEventListener('close', () => {
      closed = true;
      deliver({ value: undefined as never, done: true });
    });
    socket.addEventListener('error', () => {
      // The DOM CloseEvent / Event delivered here carries no useful diagnostic
      // beyond "the runtime decided this socket is unusable". Convey what we
      // can; if the message-side parse already populated pendingError, keep it.
      if (pendingError === null) pendingError = new Error('BroadcastDO socket error');
      void closeAndEnd();
    });
    return socket;
  })();
  openPromise.catch(err => {
    pendingError = err;
    closed = true;
    deliver({ value: undefined as never, done: true });
  });

  // Symmetric termination — every path that flips `closed` also has to close
  // the upstream socket, otherwise an abort or parse-error leaks one WS in
  // the DO's hibernation registry per subscriber session. Awaiting
  // `openPromise` covers the still-handshaking case: a teardown that races
  // the open still gets to close the socket once it materializes.
  const closeAndEnd = async (): Promise<void> => {
    const s = await openPromise.catch(() => null);
    if (s) s.close(1000, 'subscriber done');
    if (closed) return;
    closed = true;
    deliver({ value: undefined as never, done: true });
  };

  signal.addEventListener('abort', () => {
    void closeAndEnd();
  }, { once: true });

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
      async next(): Promise<IteratorResult<DumpMetadata>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) {
          if (pendingError) throw pendingError;
          return { value: undefined as never, done: true };
        }
        const result = await new Promise<IteratorResult<DumpMetadata>>(resolve => { resolveNext = resolve; });
        if (result.done && pendingError) throw pendingError;
        return result;
      },
      async return(): Promise<IteratorResult<DumpMetadata>> {
        await closeAndEnd();
        return { value: undefined as never, done: true };
      },
    }),
  };
};
