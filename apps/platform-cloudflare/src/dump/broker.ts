import type { DumpBroker } from '@floway-dev/platform';
import type { DumpMetadata } from '@floway-dev/protocols/dump';

// Minimal namespace surface from the worker's KEY_DUMP_DO binding. Matches
// the subset of `DurableObjectNamespace` we actually call — keeps this file
// off the workers-types dependency.
export interface KeyDumpNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): KeyDumpStub;
}

interface KeyDumpStub {
  // Direct RPC method invocation — see KeyDumpDO for the documented pattern.
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

interface AppendedFrame {
  event: typeof APPENDED_EVENT;
  data: DumpMetadata;
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

  const decodeFrame = (data: string | ArrayBuffer): AppendedFrame => {
    const text = typeof data === 'string' ? data : new TextDecoder().decode(data);
    const parsed = JSON.parse(text) as { event: unknown; data: unknown };
    if (parsed.event !== APPENDED_EVENT) {
      throw new Error(`KeyDumpDO emitted unknown event ${String(parsed.event)}`);
    }
    return { event: APPENDED_EVENT, data: parsed.data as DumpMetadata };
  };

  const openPromise = (async (): Promise<WebSocket> => {
    const response = await stub.fetch(new Request('https://dump.do/subscribe', {
      headers: { Upgrade: 'websocket' },
    }));
    if (response.status !== 101) {
      throw new Error(`KeyDumpDO subscribe returned HTTP ${response.status} instead of 101`);
    }
    const socket = (response as Response & { webSocket?: WebSocket }).webSocket!;
    socket.accept();
    socket.addEventListener('message', event => {
      if (closed) return;
      try {
        const frame = decodeFrame(event.data as string | ArrayBuffer);
        deliver({ value: frame.data, done: false });
      } catch (err) {
        pendingError = err;
        closeAndEnd(socket);
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
      if (pendingError === null) pendingError = new Error('KeyDumpDO socket error');
      closeAndEnd(socket);
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
  // the DO's hibernation registry per subscriber session.
  const closeSocketIfOpened = async (): Promise<void> => {
    const s = await openPromise.catch(() => null);
    if (s) s.close(1000, 'subscriber done');
  };
  const closeAndEnd = (socket: WebSocket): void => {
    if (closed) return;
    closed = true;
    socket.close(1000, 'subscriber done');
    deliver({ value: undefined as never, done: true });
  };

  signal.addEventListener('abort', () => {
    if (closed) return;
    closed = true;
    deliver({ value: undefined as never, done: true });
    void closeSocketIfOpened();
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
        closed = true;
        await closeSocketIfOpened();
        return { value: undefined as never, done: true };
      },
    }),
  };
};
