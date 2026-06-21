import type { ChannelBroker, Codec } from '@floway-dev/gateway/channel-broker';

// Minimal namespace surface for BROADCAST_DO — declared locally so this
// file stays off `@cloudflare/workers-types`.
export interface BroadcastNamespace {
  idFromName(name: string): unknown;
  get(id: unknown): BroadcastStub;
}

interface BroadcastStub {
  broadcast(payload: string): Promise<void>;
  closeAll(reason: string): Promise<void>;
  fetch(request: Request): Promise<Response>;
}

// Per-channel publish/subscribe over a Durable Object: each channelId resolves
// to one BroadcastDO instance via `namespace.idFromName(channelId)`. The actor
// fans `broadcast(string)` out to every WebSocket subscriber; this class
// applies the caller-supplied codec on both ends so the actor itself stays
// content-agnostic.
export class DurableObjectChannelBroker<T> implements ChannelBroker<T> {
  constructor(
    private readonly namespace: BroadcastNamespace,
    private readonly codec: Codec<T>,
  ) {}

  private stub(channelId: string): BroadcastStub {
    return this.namespace.get(this.namespace.idFromName(channelId));
  }

  async publish(channelId: string, payload: T): Promise<void> {
    await this.stub(channelId).broadcast(this.codec.encode(payload));
  }

  async closeChannel(channelId: string, reason: string): Promise<void> {
    await this.stub(channelId).closeAll(reason);
  }

  subscribe(channelId: string, signal: AbortSignal): AsyncIterable<T> {
    return iterateFromBroadcastSocket<T>(this.stub(channelId), signal, this.codec);
  }
}

// Listener registration and socket open run eagerly so a broadcast that races
// against the iterator drain still buffers into the queue and lands on the
// next read.
const iterateFromBroadcastSocket = <T>(
  stub: BroadcastStub,
  signal: AbortSignal,
  codec: Codec<T>,
): AsyncIterable<T> => {
  const queue: T[] = [];
  let resolveNext: ((value: IteratorResult<T>) => void) | null = null;
  let pendingError: unknown = null;
  let closed = false;

  const deliver = (value: IteratorResult<T>): void => {
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
        const raw = event.data as string | ArrayBuffer;
        const text = typeof raw === 'string' ? raw : new TextDecoder().decode(raw);
        deliver({ value: codec.decode(text), done: false });
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
      // Error events carry no useful payload; preserve any earlier pendingError.
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
  // the DO's hibernation registry per subscriber session. Flip `closed`
  // first so a concurrent invocation short-circuits before either issues
  // its own close; awaiting `openPromise` after that covers the still-
  // handshaking case so a teardown that races the open still tears down
  // the socket once it materializes.
  const closeAndEnd = async (): Promise<void> => {
    if (closed) return;
    closed = true;
    deliver({ value: undefined as never, done: true });
    const s = await openPromise.catch(() => null);
    if (s) s.close(1000, 'subscriber done');
  };

  signal.addEventListener('abort', () => {
    void closeAndEnd();
  }, { once: true });

  return {
    [Symbol.asyncIterator]: (): AsyncIterator<T> => ({
      async next(): Promise<IteratorResult<T>> {
        if (queue.length > 0) return { value: queue.shift()!, done: false };
        if (closed) {
          if (pendingError) throw pendingError;
          return { value: undefined as never, done: true };
        }
        const result = await new Promise<IteratorResult<T>>(resolve => { resolveNext = resolve; });
        if (result.done && pendingError) throw pendingError;
        return result;
      },
      async return(): Promise<IteratorResult<T>> {
        await closeAndEnd();
        return { value: undefined as never, done: true };
      },
    }),
  };
};
