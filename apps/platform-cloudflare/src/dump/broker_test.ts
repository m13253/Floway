import { test } from 'vitest';

import { DurableObjectDumpBroker, type KeyDumpNamespace } from './broker.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assertEquals, fakeMeta } from '@floway-dev/test-utils';

class FakeServerSocket {
  readonly listeners = new Map<string, Set<(e: Event) => void>>();
  closed: { code: number; reason: string } | null = null;
  sent: string[] = [];

  addEventListener(type: string, fn: (e: Event) => void): void {
    const set = this.listeners.get(type) ?? new Set();
    set.add(fn);
    this.listeners.set(type, set);
  }
  removeEventListener(type: string, fn: (e: Event) => void): void {
    this.listeners.get(type)?.delete(fn);
  }
  accept(): void { /* noop */ }
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    // workerd emits the 'close' event asynchronously after close() returns;
    // mirror that here so subscribers can't observe a synchronous close.
    queueMicrotask(() => this.emit('close', new Event('close')));
  }
  send(data: string): void { this.sent.push(data); }
  emit(type: string, event: Event): void {
    for (const fn of this.listeners.get(type) ?? []) fn(event);
  }
}

const buildNamespace = (socket: FakeServerSocket) => {
  const ns: KeyDumpNamespace = {
    idFromName(_name) { return {}; },
    get(_id) {
      return {
        publish: async () => {},
        notifyDisabled: async () => {},
        fetch: async () => {
          // Real CF returns 101; Node's `Response` rejects status 101 in its
          // constructor, so synthesise it by overriding `status` after the
          // fact. The broker only reads `status` and `webSocket`.
          const response = new Response(null, { status: 200 });
          Object.defineProperty(response, 'status', { value: 101, configurable: true });
          (response as Response & { webSocket?: unknown }).webSocket = socket;
          return response;
        },
      };
    },
  };
  return ns;
};

test('DurableObjectDumpBroker.subscribe drives metas through the DO socket', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectDumpBroker(buildNamespace(socket));
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  // Let the subscribe coroutine attach its listeners (one microtask is enough).
  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ event: 'appended', data: fakeMeta({ id: 'A1' }) }) }));
  const first = await iter.next();
  assertEquals(first.value!.id, 'A1');

  // Abort alone must end the iterator AND close the upstream socket — without
  // the close, every SSE disconnect would orphan one WS in the DO hibernation
  // registry per subscriber session.
  controller.abort();
  const end = await iter.next();
  assertEquals(end.done, true);
  // Microtask drains the abort handler's openPromise-then-close chain.
  await Promise.resolve();
  await Promise.resolve();
  assertEquals(socket.closed?.code, 1000);
});

test('DurableObjectDumpBroker.publish dispatches through the namespace stub', async () => {
  const calls: DumpMetadata[] = [];
  const ns: KeyDumpNamespace = {
    idFromName(_name) { return {}; },
    get(_id) {
      return {
        publish: async meta => { calls.push(meta); },
        notifyDisabled: async () => {},
        fetch: async () => new Response(null),
      };
    },
  };
  const broker = new DurableObjectDumpBroker(ns);
  await broker.publish('k', fakeMeta({ id: 'A1' }));
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.id, 'A1');
});
