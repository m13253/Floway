import { test } from 'vitest';

import { DurableObjectDumpBroker, type KeyDumpNamespace } from './broker.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

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
    this.closed = { code, reason };
    this.emit('close', new Event('close'));
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
          // Real CF returns 101 here; node Response refuses to construct 101,
          // so we pin to 200 — the broker only reads `.webSocket`, never the
          // status, so the substitution is invisible to the code under test.
          const response = new Response(null, { status: 200 });
          (response as Response & { webSocket?: unknown }).webSocket = socket;
          return response;
        },
      };
    },
  };
  return ns;
};

const fakeMeta = (id: string): DumpMetadata => ({
  id, startedAt: 0, completedAt: 1, method: 'POST', path: '/v1/x', status: 200,
  upstream: null, model: null, inputTokens: null, outputTokens: null,
  requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
});

test('DurableObjectDumpBroker.subscribe drives metas through the DO socket', async () => {
  const socket = new FakeServerSocket();
  const broker = new DurableObjectDumpBroker(buildNamespace(socket));
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  // Let the subscribe coroutine attach its listeners (one microtask is enough).
  await Promise.resolve();
  await Promise.resolve();
  socket.emit('message', new MessageEvent('message', { data: JSON.stringify({ event: 'appended', data: fakeMeta('A1') }) }));
  const first = await iter.next();
  assertEquals(first.value!.id, 'A1');

  controller.abort();
  socket.close();
  const end = await iter.next();
  assertEquals(end.done, true);
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
  await broker.publish('k', fakeMeta('A1'));
  assertEquals(calls.length, 1);
  assertEquals(calls[0]!.id, 'A1');
});
