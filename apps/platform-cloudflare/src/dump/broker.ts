import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal namespace surface from the worker's KEY_DUMP_DO binding. Matches
// the subset of `DurableObjectNamespace` we actually call — keeps this file
// off the workers-types dependency.
export interface KeyDumpNamespace {
  idFromName(name: string): KeyDumpId;
  get(id: KeyDumpId): KeyDumpStub;
}

interface KeyDumpId { /* opaque */ }

interface KeyDumpStub {
  // Direct method invocation works on workers-types v4+ when the DO class
  // is part of the same Worker; the CF runtime auto-marshals the call into
  // an RPC to the actor. We rely on that here so the producer side stays
  // ergonomic and doesn't have to build Request objects for every publish.
  publish(meta: DumpMetadata): Promise<void>;
  notifyDisabled(): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

const APPENDED_EVENT = 'appended';

export class DurableObjectDumpBroker implements DumpBroker {
  constructor(private readonly namespace: KeyDumpNamespace) {}

  private stub(keyId: string): KeyDumpStub {
    return this.namespace.get(this.namespace.idFromName(keyId));
  }

  async publish(keyId: string, meta: DumpMetadata): Promise<void> {
    await this.stub(keyId).publish(meta);
  }

  async notifyDisabled(keyId: string): Promise<void> {
    await this.stub(keyId).notifyDisabled();
  }

  subscribe(keyId: string, signal: AbortSignal): AsyncIterable<DumpMetadata> {
    return iterateFromDoSocket(this.stub(keyId), signal);
  }
}

// Drive an async iterator from the WS the DO returns. The socket open + the
// message listener attach run eagerly here — before the caller awaits the
// iterator's first `.next()` — so a publish that races against the iterator
// drain still buffers into the queue and lands on the next read.
const iterateFromDoSocket = (stub: KeyDumpStub, signal: AbortSignal): AsyncIterable<DumpMetadata> => {
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

  const onAbort = (): void => {
    if (closed) return;
    closed = true;
    deliver({ value: undefined as never, done: true });
  };
  signal.addEventListener('abort', onAbort, { once: true });

  const openPromise = (async (): Promise<WebSocket> => {
    const response = await stub.fetch(new Request('https://dump.do/subscribe', {
      headers: { Upgrade: 'websocket' },
    }));
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket;
    if (!socket) throw new Error('KeyDumpDO did not return a WebSocket');
    socket.accept();
    socket.addEventListener('message', event => {
      if (closed) return;
      try {
        const parsed = JSON.parse(typeof event.data === 'string' ? event.data : new TextDecoder().decode(event.data as ArrayBuffer));
        if (parsed?.event === APPENDED_EVENT) {
          deliver({ value: parsed.data as DumpMetadata, done: false });
        }
      } catch (err) {
        pendingError = err;
        closed = true;
        deliver({ value: undefined as never, done: true });
      }
    });
    socket.addEventListener('close', () => {
      closed = true;
      deliver({ value: undefined as never, done: true });
    });
    socket.addEventListener('error', () => {
      closed = true;
      pendingError ??= new Error('KeyDumpDO socket error');
      deliver({ value: undefined as never, done: true });
    });
    return socket;
  })();
  openPromise.catch(err => {
    pendingError = err;
    closed = true;
    deliver({ value: undefined as never, done: true });
  });

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
        closed = true;
        const socket = await openPromise.catch(() => null);
        if (socket) {
          try { socket.close(1000, 'subscriber done'); } catch { /* may already be closed */ }
        }
        return { value: undefined as never, done: true };
      },
    }),
  };
};
