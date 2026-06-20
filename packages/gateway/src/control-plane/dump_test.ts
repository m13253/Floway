import { test } from 'vitest';

import { setDumpBroker, setDumpStore } from '../runtime/dump.ts';
import { requestApp, setupAppTest } from '../test-helpers.ts';
import type { DumpBroker, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Compact in-memory pair we can swap into the runtime per-test. The store
// behaves as a real (newest-first) list and the broker yields whatever is
// dispatched via `push`. Returned helpers make the test side ergonomic.
const installStubs = () => {
  const records = new Map<string, DumpRecord[]>();
  const subscribers = new Map<string, Array<(meta: DumpMetadata | null) => void>>();

  const store: DumpStore = {
    async put(keyId, record) {
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    async list(keyId, opts) {
      const list = records.get(keyId) ?? [];
      let start = 0;
      if (opts.before) {
        const idx = list.findIndex(r => r.meta.id === opts.before);
        start = idx >= 0 ? idx + 1 : list.length;
      }
      return list.slice(start, start + opts.limit).map(r => r.meta);
    },
    async get(keyId, id) {
      return (records.get(keyId) ?? []).find(r => r.meta.id === id) ?? null;
    },
    async purgeAll() { /* noop */ },
    async purgeExpired() { /* noop */ },
  };
  const broker: DumpBroker = {
    async publish(keyId, meta) {
      for (const fn of subscribers.get(keyId) ?? []) fn(meta);
    },
    async notifyDisabled(keyId) {
      for (const fn of subscribers.get(keyId) ?? []) fn(null);
    },
    subscribe(keyId, signal) {
      // Eager listener registration so a publish between subscribe() and the
      // iterator's first read still lands in the queue. Mirrors the
      // production Node + CF brokers.
      const queue: DumpMetadata[] = [];
      let resolveNext: ((v: IteratorResult<DumpMetadata>) => void) | null = null;
      let closed = false;
      const onMeta = (meta: DumpMetadata | null): void => {
        if (closed) return;
        if (meta === null) {
          closed = true;
          if (resolveNext) { resolveNext({ value: undefined as never, done: true }); resolveNext = null; }
          return;
        }
        if (resolveNext) { resolveNext({ value: meta, done: false }); resolveNext = null; } else queue.push(meta);
      };
      const list = subscribers.get(keyId) ?? [];
      list.push(onMeta);
      subscribers.set(keyId, list);
      signal.addEventListener('abort', () => onMeta(null), { once: true });
      const detach = (): void => {
        const next = (subscribers.get(keyId) ?? []).filter(fn => fn !== onMeta);
        if (next.length === 0) subscribers.delete(keyId);
        else subscribers.set(keyId, next);
      };
      return {
        [Symbol.asyncIterator]: (): AsyncIterator<DumpMetadata> => ({
          async next() {
            if (queue.length > 0) return { value: queue.shift()!, done: false };
            if (closed) { detach(); return { value: undefined as never, done: true }; }
            const v = await new Promise<IteratorResult<DumpMetadata>>(r => { resolveNext = r; });
            if (v.done) detach();
            return v;
          },
          async return() { closed = true; detach(); return { value: undefined as never, done: true }; },
        }),
      };
    },
  };

  return {
    store,
    broker,
    seed: (keyId: string, record: DumpRecord) => {
      const list = records.get(keyId) ?? [];
      list.unshift(record);
      records.set(keyId, list);
    },
    publish: (keyId: string, meta: DumpMetadata) => broker.publish(keyId, meta),
  };
};

const fakeMeta = (id: string, completedAt: number): DumpMetadata => ({
  id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
  upstream: null, model: null, inputTokens: null, outputTokens: null,
  requestBytes: 0, responseBytes: 0, durationMs: 1, error: null,
});

const fakeRecord = (id: string, completedAt: number): DumpRecord => ({
  meta: fakeMeta(id, completedAt),
  request: { method: 'POST', path: '/v1/x', headers: [], body: '' },
  response: { status: 200, headers: [], type: 'none' },
});

test('GET /api/dump/keys/:keyId/records lists newest-first', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A2', 2000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.length, 2);
  assertEquals(body.records[0]!.id, '01HZZ0000000000000000000A2');
});

test('GET /api/dump/keys/:keyId/records paginates via ?before=', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A2', 2000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records?before=01HZZ0000000000000000000A2`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as { records: DumpMetadata[] };
  assertEquals(body.records.length, 1);
  assertEquals(body.records[0]!.id, '01HZZ0000000000000000000A1');
});

test('GET /api/dump/keys/:keyId/records rejects fractional limit', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=1.5`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 400);
});

test('GET /api/dump/keys/:keyId/records 404s when the key has no retention', async () => {
  const { apiKey } = await setupAppTest();
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records/:recordId returns the rehydrated record', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000XX', 1000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01HZZ0000000000000000000XX`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json() as DumpRecord;
  assertEquals(body.meta.id, '01HZZ0000000000000000000XX');
});

test('GET /api/dump/keys/:keyId/records/:recordId 404s on unknown id', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01HZZ0000000000000000000ZZ`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/stream sends snapshot then appended frames', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker(stubs.broker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collected: string[] = [];

  const pump = async (): Promise<void> => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      while (buffer.includes('\n\n')) {
        const idx = buffer.indexOf('\n\n');
        collected.push(buffer.slice(0, idx));
        buffer = buffer.slice(idx + 2);
        if (collected.length >= 2) return;
      }
    }
  };
  const pumpPromise = pump();

  // Race-prone but the broker is in-process; small delay is enough for the
  // snapshot frame to land and the subscribe loop to attach.
  await new Promise(r => setTimeout(r, 10));
  await stubs.publish(apiKey.id, fakeMeta('01HZZ0000000000000000000A2', 2000));
  await pumpPromise;
  void reader.cancel();

  const snapshotFrame = collected[0]!;
  assertEquals(snapshotFrame.includes('event: snapshot'), true);
  assertEquals(snapshotFrame.includes('01HZZ0000000000000000000A1'), true);

  const appendedFrame = collected[1]!;
  assertEquals(appendedFrame.includes('event: appended'), true);
  assertEquals(appendedFrame.includes('01HZZ0000000000000000000A2'), true);
});

test('GET /api/dump/keys/:keyId/stream emits event: error when broker throws mid-stream', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore(stubs.store);
  setDumpBroker({
    ...stubs.broker,
    subscribe(_keyId, _signal) {

      return (async function*() {
        throw new Error('broker exploded');
      })();
    },
  });

  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collected: string[] = [];
  while (collected.length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n');
      collected.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  void reader.cancel();
  assertExists(collected.find(frame => frame.includes('event: error') && frame.includes('broker exploded')));
});

test('GET /api/dump/keys/:keyId/stream delivers a frame appended during snapshot read', async () => {
  // Race regression: a record published between snapshot SELECT and subscribe
  // arm must surface as an `appended` frame after the snapshot frame, not be
  // dropped on the floor.
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({ ...apiKey, dumpRetentionSeconds: 3600 });
  const stubs = installStubs();
  setDumpStore({
    ...stubs.store,
    // Slow the snapshot read so we have a window to publish into.
    list: async (keyId, opts) => {
      await new Promise(r => setTimeout(r, 30));
      return await stubs.store.list(keyId, opts);
    },
  });
  setDumpBroker(stubs.broker);
  stubs.seed(apiKey.id, fakeRecord('01HZZ0000000000000000000A1', 1000));

  const responsePromise = requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
  });
  // Publish into the window: subscribe attaches its listener before awaiting
  // the slow snapshot, so the frame is buffered for the iterator's first read.
  await new Promise(r => setTimeout(r, 10));
  await stubs.publish(apiKey.id, fakeMeta('01HZZ0000000000000000000A2', 2000));

  const response = await responsePromise;
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  const collected: string[] = [];
  while (collected.length < 2) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    while (buffer.includes('\n\n')) {
      const idx = buffer.indexOf('\n\n');
      collected.push(buffer.slice(0, idx));
      buffer = buffer.slice(idx + 2);
    }
  }
  void reader.cancel();

  const appendedIds = collected
    .filter(f => f.includes('event: appended'))
    .map(f => /A\d/.exec(f)?.[0]);
  assertEquals(appendedIds.includes('A2'), true);
});
