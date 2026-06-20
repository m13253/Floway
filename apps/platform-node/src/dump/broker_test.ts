import { test } from 'vitest';

import { InProcessDumpBroker } from './broker.ts';
import type { DumpMetadata } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

const fakeMeta = (id: string): DumpMetadata => ({
  id, startedAt: 0, completedAt: 1, method: 'POST', path: '/v1/x', status: 200,
  upstream: null, model: null, inputTokens: null, outputTokens: null,
  requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
});

test('InProcessDumpBroker delivers published metas to a live subscriber', async () => {
  const broker = new InProcessDumpBroker();
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await broker.publish('k', fakeMeta('A1'));
  await broker.publish('k', fakeMeta('A2'));
  controller.abort();

  // Two seeded items + the abort-induced terminal value.
  assertEquals((await iter.next()).value!.id, 'A1');
  assertEquals((await iter.next()).value!.id, 'A2');
  assertEquals((await iter.next()).done, true);
});

test('InProcessDumpBroker isolates traffic across keys', async () => {
  const broker = new InProcessDumpBroker();
  const controller = new AbortController();
  const iter = broker.subscribe('k1', controller.signal)[Symbol.asyncIterator]();
  await broker.publish('k2', fakeMeta('foreign'));
  await broker.publish('k1', fakeMeta('local'));
  controller.abort();

  const first = await iter.next();
  assertEquals(first.value!.id, 'local');
  assertEquals((await iter.next()).done, true);
});

test('InProcessDumpBroker.notifyDisabled ends every subscriber on the key', async () => {
  const broker = new InProcessDumpBroker();
  const c1 = new AbortController();
  const c2 = new AbortController();
  const i1 = broker.subscribe('k', c1.signal)[Symbol.asyncIterator]();
  const i2 = broker.subscribe('k', c2.signal)[Symbol.asyncIterator]();

  await broker.notifyDisabled('k');
  assertEquals((await i1.next()).done, true);
  assertEquals((await i2.next()).done, true);
});

test('InProcessDumpBroker detaches its EventTarget listeners when the subscriber aborts before pulling', async () => {
  // Spy on the inner EventTarget so we can count addEventListener vs
  // removeEventListener calls; the leak this test pins regressed when the
  // abort path didn't call detach() because deliver({done:true}) was a no-op
  // with no waiting resolveNext.
  const originalAdd = EventTarget.prototype.addEventListener;
  const originalRemove = EventTarget.prototype.removeEventListener;
  let adds = 0;
  let removes = 0;
  EventTarget.prototype.addEventListener = function (...args: Parameters<EventTarget['addEventListener']>) {
    adds += 1;
    return originalAdd.apply(this, args);
  };
  EventTarget.prototype.removeEventListener = function (...args: Parameters<EventTarget['removeEventListener']>) {
    removes += 1;
    return originalRemove.apply(this, args);
  };
  try {
    const broker = new InProcessDumpBroker();
    const controller = new AbortController();
    // Subscribe — eager listener attach happens here.
    broker.subscribe('k', controller.signal);
    const after = adds;
    // Abort immediately without ever calling next(); the prior behavior would
    // leak the 'appended'/'disabled' listeners forever.
    controller.abort();
    // Two listeners on the target (appended + disabled) plus the abort
    // listener on the signal must be removed.
    assertEquals(removes - (after - adds) >= 3 ? 'detached' : `leaked (adds=${adds} removes=${removes})`, 'detached');
  } finally {
    EventTarget.prototype.addEventListener = originalAdd;
    EventTarget.prototype.removeEventListener = originalRemove;
  }
});
