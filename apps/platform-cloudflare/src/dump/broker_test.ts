import { test } from 'vitest';

import { createCloudflareDumpBroker } from './broker.ts';
import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assert, assertEquals } from '@floway-dev/test-utils';

// Two-ended WebSocket pair double, mirroring the workerd shape: a real
// WebSocketPair has independent client and server endpoints, and send() on
// one fires a 'message' event on the other. The broker calls accept() on
// the value returned by fetch().webSocket — which is the client side. The
// DO would normally call send() on its server side; here the test publishes
// via server.send() and asserts client.dispatchEvent surfaces it.
class FakeWebSocket extends EventTarget {
  peer: FakeWebSocket | null = null;
  accept(): void {}

  send(payload: string): void {
    this.peer?.dispatchEvent(new MessageEvent('message', { data: payload }));
  }

  close(): void {
    this.peer?.dispatchEvent(new Event('close'));
    this.dispatchEvent(new Event('close'));
  }
}

const fakePair = (): { client: FakeWebSocket; server: FakeWebSocket } => {
  const client = new FakeWebSocket();
  const server = new FakeWebSocket();
  client.peer = server;
  server.peer = client;
  return { client, server };
};

const fakeNamespace = (client: FakeWebSocket): DurableObjectNamespace<KeyDumpDO> => ({
  idFromName: name => ({ name }),
  get: () => ({
    fetch: async () => ({ webSocket: client }) as unknown as Response,
  }) as unknown as DurableObjectStub & KeyDumpDO,
});

const meta = (id: string): DumpMetadata => ({
  id,
  startedAt: 1_700_000_000_000,
  completedAt: 1_700_000_000_010,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  requestBytes: 0,
  responseBytes: 0,
  durationMs: 10,
  error: null,
});

test('subscribe yields published metadata in order then exits when the server closes the socket', async () => {
  const { client, server } = fakePair();
  const broker = createCloudflareDumpBroker(fakeNamespace(client));
  const controller = new AbortController();

  const received: DumpMetadata[] = [];
  const subscriber = (async () => {
    for await (const m of broker.subscribe('key1', controller.signal)) {
      received.push(m);
    }
  })();

  // Allow the subscribe generator to attach its listeners before we publish.
  await Promise.resolve();
  server.send(JSON.stringify(meta('a')));
  server.send(JSON.stringify(meta('b')));

  // Server-initiated close (DO eviction, retention turned off mid-session).
  // Without the closed-flag fix this hangs forever inside the await.
  await new Promise(resolve => setTimeout(resolve, 5));
  server.close();

  // Bound the wait — the iterator must end on its own; if it doesn't, the
  // race below keeps the test from hanging indefinitely so the failure mode
  // is a clear timeout assertion instead of a Vitest-level deadlock.
  const ended = await Promise.race([
    subscriber.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  assert(ended, 'subscribe should return after the server-side WebSocket close');
  assertEquals(received.map(m => m.id), ['a', 'b']);
});

test('signal.abort ends the iterator and closes the underlying socket', async () => {
  const { client } = fakePair();
  let closed = false;
  const closingClient = Object.assign(client, {
    close() { closed = true; client.dispatchEvent(new Event('close')); },
  });
  const broker = createCloudflareDumpBroker(fakeNamespace(closingClient));
  const controller = new AbortController();

  let ended = false;
  const subscriber = (async () => {
    for await (const _m of broker.subscribe('key1', controller.signal)) {
    }
    ended = true;
  })();

  await Promise.resolve();
  controller.abort();
  const finished = await Promise.race([
    subscriber.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);

  assert(finished, 'subscribe should return after the signal aborts');
  assertEquals(ended, true);
  assertEquals(closed, true);
});

test('each subscriber consumes its own per-key DO socket independently', async () => {
  // CF broker has no in-process fanout — every subscribe() opens a new
  // WebSocket against the per-key DO, which is the unit that fans out.
  // The test confirms each socket is wired independently so each delivers
  // its server's pushes, mirroring the per-key DO's actual behavior.
  const pairs = [fakePair(), fakePair()];
  let nextClient = 0;
  const ns: DurableObjectNamespace<KeyDumpDO> = {
    idFromName: name => ({ name }),
    get: () => ({
      fetch: async () => ({ webSocket: pairs[nextClient++]!.client }) as unknown as Response,
    }) as unknown as DurableObjectStub & KeyDumpDO,
  };
  const broker = createCloudflareDumpBroker(ns);

  const ctlA = new AbortController();
  const ctlB = new AbortController();
  const receivedA: DumpMetadata[] = [];
  const receivedB: DumpMetadata[] = [];

  const subA = (async () => {
    for await (const m of broker.subscribe('key1', ctlA.signal)) {
      receivedA.push(m);
      if (receivedA.length === 1) ctlA.abort();
    }
  })();
  const subB = (async () => {
    for await (const m of broker.subscribe('key1', ctlB.signal)) {
      receivedB.push(m);
      if (receivedB.length === 1) ctlB.abort();
    }
  })();

  await Promise.resolve();
  // Each subscriber owns its own server endpoint; simulating the DO's fanout
  // means publishing on both servers.
  pairs[0]!.server.send(JSON.stringify(meta('x')));
  pairs[1]!.server.send(JSON.stringify(meta('x')));

  await Promise.all([subA, subB]);
  assertEquals(receivedA.map(m => m.id), ['x']);
  assertEquals(receivedB.map(m => m.id), ['x']);
});

test('a transport error on the underlying socket throws from the iterator (not a clean return)', async () => {
  // The control-plane pump records iterator throws into `brokerError` and
  // writes a final `event: error` SSE frame. Treating an `error` event like
  // a clean close would mute that frame, so the broker must surface the
  // failure as a throw the pump can catch.
  const { client } = fakePair();
  const broker = createCloudflareDumpBroker(fakeNamespace(client));
  const controller = new AbortController();

  let thrown: unknown = null;
  const subscriber = (async () => {
    try {
      for await (const _m of broker.subscribe('key1', controller.signal)) {}
    } catch (e) {
      thrown = e;
    }
  })();

  await Promise.resolve();
  client.dispatchEvent(new ErrorEvent('error', { message: 'simulated socket failure' }));

  const finished = await Promise.race([
    subscriber.then(() => true),
    new Promise<false>(resolve => setTimeout(() => resolve(false), 1000)),
  ]);
  assertEquals(finished, true);
  assertEquals(thrown instanceof Error, true);
  assertEquals((thrown as Error).message, 'broker websocket errored: simulated socket failure');
});
