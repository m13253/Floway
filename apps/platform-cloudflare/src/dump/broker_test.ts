import { test } from 'vitest';

import { DurableObjectDumpBroker, type BroadcastNamespace } from './broker.ts';
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

const buildNamespace = (socket: FakeServerSocket, broadcasts: string[] = [], closeAlls: string[] = []) => {
  const ns: BroadcastNamespace = {
    idFromName(_name) { return {}; },
    get(_id) {
      return {
        broadcast: async payload => { broadcasts.push(payload); },
        closeAll: async reason => { closeAlls.push(reason); },
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

test('DurableObjectDumpBroker.subscribe drives metas through the broadcast socket', async () => {
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

test('DurableObjectDumpBroker.publish dispatches an appended frame through broadcast', async () => {
  const broadcasts: string[] = [];
  const ns = buildNamespace(new FakeServerSocket(), broadcasts);
  const broker = new DurableObjectDumpBroker(ns);
  await broker.publish('k', fakeMeta({ id: 'A1' }));
  assertEquals(broadcasts.length, 1);
  const parsed = JSON.parse(broadcasts[0]!) as { event: string; data: { id: string } };
  assertEquals(parsed.event, 'appended');
  assertEquals(parsed.data.id, 'A1');
});

test('DurableObjectDumpBroker.notifyDisabled translates to closeAll with the documented reason', async () => {
  const closeAlls: string[] = [];
  const ns = buildNamespace(new FakeServerSocket(), [], closeAlls);
  const broker = new DurableObjectDumpBroker(ns);
  await broker.notifyDisabled('k');
  assertEquals(closeAlls.length, 1);
  assertEquals(closeAlls[0], 'dump retention disabled');
});
