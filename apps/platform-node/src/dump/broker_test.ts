import { test } from 'vitest';

import { InProcessDumpBroker } from './broker.ts';
import { fakeMeta } from '@floway-dev/gateway/dump/test-fixtures';
import { assertEquals } from '@floway-dev/test-utils';

test('InProcessDumpBroker delivers published metas to a live subscriber', async () => {
  const broker = new InProcessDumpBroker();
  const controller = new AbortController();
  const iter = broker.subscribe('k', controller.signal)[Symbol.asyncIterator]();

  await broker.publish('k', fakeMeta({ id: 'A1' }));
  await broker.publish('k', fakeMeta({ id: 'A2' }));
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
  await broker.publish('k2', fakeMeta({ id: 'foreign' }));
  await broker.publish('k1', fakeMeta({ id: 'local' }));
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
  // Spy on `removeEventListener` so we can count detach calls. The abort path
  // must detach the listeners synchronously rather than waiting for a future
  // iterator pull.
  const originalRemove = EventTarget.prototype.removeEventListener;
  let removes = 0;
  EventTarget.prototype.removeEventListener = function (...args: Parameters<EventTarget['removeEventListener']>) {
    removes += 1;
    return originalRemove.apply(this, args);
  };
  try {
    const broker = new InProcessDumpBroker();
    const controller = new AbortController();
    broker.subscribe('k', controller.signal);
    // Snapshot the removal counter immediately before the abort so the test
    // scopes the assertion to the listeners this subscribe actually owns.
    const removesBefore = removes;
    controller.abort();
    // Two listeners on the EventTarget (appended + disabled) plus the abort
    // listener on the signal must be removed.
    assertEquals(removes - removesBefore, 3);
  } finally {
    EventTarget.prototype.removeEventListener = originalRemove;
  }
});
