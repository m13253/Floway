import { test } from 'vitest';

import { NodeDumpBroker } from './broker.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

const meta = (id: string, startedAt: number): DumpMetadata => ({
  id,
  startedAt,
  completedAt: startedAt + 10,
  method: 'POST',
  path: '/v1/messages',
  status: 200,
  upstream: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  durationMs: 10,
  error: null,
});

// Yield control so the subscriber loop's await Promise resolves and the
// generator can read the next value before publish() is observed.
const tick = (): Promise<void> => new Promise(resolve => setImmediate(resolve));

test('subscribe yields published metadata in publish order', async () => {
  const broker = new NodeDumpBroker();
  const controller = new AbortController();

  const received: DumpMetadata[] = [];
  const subscriber = (async () => {
    for await (const m of broker.subscribe('key1', controller.signal)) {
      received.push(m);
      if (received.length === 3) controller.abort();
    }
  })();

  await tick();
  broker.publish('key1', meta('a', 1));
  broker.publish('key1', meta('b', 2));
  broker.publish('key1', meta('c', 3));

  await subscriber;
  assertEquals(received.map(m => m.id), ['a', 'b', 'c']);
});

test('signal.abort ends the iterator', async () => {
  const broker = new NodeDumpBroker();
  const controller = new AbortController();

  let ended = false;
  const subscriber = (async () => {
    for await (const _m of broker.subscribe('key1', controller.signal)) {
      // No-op — should never run because we abort before publishing anything.
    }
    ended = true;
  })();

  await tick();
  controller.abort();
  await subscriber;
  assertEquals(ended, true);
});

test('two concurrent subscribers both receive every published message', async () => {
  const broker = new NodeDumpBroker();
  const controllerA = new AbortController();
  const controllerB = new AbortController();

  const receivedA: DumpMetadata[] = [];
  const receivedB: DumpMetadata[] = [];

  const subA = (async () => {
    for await (const m of broker.subscribe('key1', controllerA.signal)) {
      receivedA.push(m);
      if (receivedA.length === 2) controllerA.abort();
    }
  })();
  const subB = (async () => {
    for await (const m of broker.subscribe('key1', controllerB.signal)) {
      receivedB.push(m);
      if (receivedB.length === 2) controllerB.abort();
    }
  })();

  await tick();
  broker.publish('key1', meta('a', 1));
  broker.publish('key1', meta('b', 2));

  await Promise.all([subA, subB]);
  assertEquals(receivedA.map(m => m.id), ['a', 'b']);
  assertEquals(receivedB.map(m => m.id), ['a', 'b']);
});

test('subscribers on different keys are isolated', async () => {
  const broker = new NodeDumpBroker();
  const controller = new AbortController();
  const received: DumpMetadata[] = [];

  const subscriber = (async () => {
    for await (const m of broker.subscribe('key1', controller.signal)) {
      received.push(m);
      if (received.length === 1) controller.abort();
    }
  })();

  await tick();
  broker.publish('key2', meta('other', 1));
  broker.publish('key1', meta('mine', 2));

  await subscriber;
  assertEquals(received.map(m => m.id), ['mine']);
});
