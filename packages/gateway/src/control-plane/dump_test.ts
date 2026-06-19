import { test } from 'vitest';

import { initDumpBroker, initDumpStore } from '../runtime/dump.ts';
import { parseSSEText, requestApp, setupAppTest } from '../test-helpers.ts';
import type { DumpBroker, DumpListOptions, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

const makeStubStore = () => {
  const records = new Map<string, DumpRecord[]>();
  const store: DumpStore = {
    async put(keyId, record) {
      const arr = records.get(keyId) ?? [];
      arr.unshift(record);
      records.set(keyId, arr);
    },
    async list(keyId, opts) {
      const all = records.get(keyId) ?? [];
      const sliced = opts.before
        ? all.slice(all.findIndex(r => r.meta.id === opts.before) + 1)
        : all;
      return sliced.slice(0, opts.limit).map(r => r.meta);
    },
    async get(keyId, recordId) {
      return records.get(keyId)?.find(r => r.meta.id === recordId) ?? null;
    },
    async purgeExpired() {},
    async purgeAll() {},
  };
  return { records, store };
};

const makeBlockingBroker = () => {
  const queues = new Map<string, DumpMetadata[]>();
  const subscribers = new Map<string, ((meta: DumpMetadata) => void)[]>();

  const broker: DumpBroker = {
    publish(keyId, meta) {
      const live = subscribers.get(keyId) ?? [];
      if (live.length > 0) {
        for (const deliver of live) deliver(meta);
        return;
      }
      const pending = queues.get(keyId) ?? [];
      pending.push(meta);
      queues.set(keyId, pending);
    },
    async *subscribe(keyId, signal) {
      while (!signal.aborted) {
        const next = await new Promise<DumpMetadata | null>(resolve => {
          const onAbort = () => {
            signal.removeEventListener('abort', onAbort);
            const list = subscribers.get(keyId) ?? [];
            subscribers.set(keyId, list.filter(d => d !== deliver));
            resolve(null);
          };
          const deliver = (meta: DumpMetadata) => {
            signal.removeEventListener('abort', onAbort);
            const list = subscribers.get(keyId) ?? [];
            subscribers.set(keyId, list.filter(d => d !== deliver));
            resolve(meta);
          };
          signal.addEventListener('abort', onAbort);
          const list = subscribers.get(keyId) ?? [];
          list.push(deliver);
          subscribers.set(keyId, list);

          const pending = queues.get(keyId);
          if (pending && pending.length > 0) {
            const head = pending.shift()!;
            queues.set(keyId, pending);
            deliver(head);
          }
        });
        if (next === null) return;
        yield next;
      }
    },
  };

  return { broker };
};

const buildRecord = (id: DumpRecordId, overrides: Partial<DumpMetadata> = {}): DumpRecord => ({
  meta: {
    id,
    startedAt: 1_700_000_000_000,
    completedAt: 1_700_000_000_010,
    method: 'POST',
    path: '/v1/messages',
    status: 200,
    upstream: 'up_copilot',
    model: 'gpt-4o',
    inputTokens: 10,
    outputTokens: 20,
    durationMs: 10,
    error: null,
    ...overrides,
  },
  request: { method: 'POST', path: '/v1/messages', headers: [], body: '' },
  response: { status: 200, headers: [], type: 'bytes', body: '' },
});

const installStubs = () => {
  const store = makeStubStore();
  const broker = makeBlockingBroker();
  initDumpStore(store.store);
  initDumpBroker(broker.broker);
  return { store, broker };
};

test('GET /api/dump/keys/:keyId/records — 404 on key not owned by session user', async () => {
  const { repo, apiKey } = await setupAppTest();
  installStubs();
  await repo.users.save({
    id: 3,
    username: 'intruder',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: null,
    canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });
  const intruderSession = (await repo.sessions.create(3)).id;
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-floway-session': intruderSession },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records — 404 on non-existent keyId', async () => {
  const { apiKey } = await setupAppTest();
  installStubs();
  const response = await requestApp('/api/dump/keys/key_does_not_exist/records', {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records/:recordId — 404 on non-existent recordId', async () => {
  const { apiKey } = await setupAppTest();
  installStubs();
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01J0MISSING`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 404);
});

test('GET /api/dump/keys/:keyId/records returns newest-first with exclusive `before` cursor', async () => {
  const { apiKey } = await setupAppTest();
  const { store } = installStubs();
  // Records are inserted oldest → newest; the stub list returns newest-first.
  await store.store.put(apiKey.id, buildRecord('01A'));
  await store.store.put(apiKey.id, buildRecord('01B'));
  await store.store.put(apiKey.id, buildRecord('01C'));

  const all = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(all.status, 200);
  const allBody = (await all.json()) as { records: DumpMetadata[] };
  assertEquals(allBody.records.map(r => r.id), ['01C', '01B', '01A']);

  const older = await requestApp(`/api/dump/keys/${apiKey.id}/records?before=01C`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(older.status, 200);
  const olderBody = (await older.json()) as { records: DumpMetadata[] };
  assertEquals(olderBody.records.map(r => r.id), ['01B', '01A']);
});

test('GET /api/dump/keys/:keyId/records limit handling', async () => {
  const { apiKey } = await setupAppTest();
  const { store } = installStubs();
  let observedLimit = -1;
  initDumpStore({
    ...store.store,
    async list(_keyId: string, opts: DumpListOptions) {
      observedLimit = opts.limit;
      return [];
    },
  });

  // Missing → default of 100 (the cap is the upper bound, not the default).
  const dflt = await requestApp(`/api/dump/keys/${apiKey.id}/records`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(dflt.status, 200);
  assertEquals(observedLimit, 100);

  // Explicit valid value passes through.
  const explicit = await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=50`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(explicit.status, 200);
  assertEquals(observedLimit, 50);

  // Over-cap → clamped to 200.
  const over = await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=10000`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(over.status, 200);
  assertEquals(observedLimit, 200);

  // Non-numeric, non-positive, and empty inputs are rejected rather than
  // silently substituted — surfacing the operator's bad input is the point.
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=abc`, {
    headers: { 'x-api-key': apiKey.key },
  })).status, 400);
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=-1`, {
    headers: { 'x-api-key': apiKey.key },
  })).status, 400);
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=0`, {
    headers: { 'x-api-key': apiKey.key },
  })).status, 400);
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records?limit=`, {
    headers: { 'x-api-key': apiKey.key },
  })).status, 400);
});

test('GET /api/dump/keys/:keyId/records/:recordId returns the full record', async () => {
  const { apiKey } = await setupAppTest();
  const { store } = installStubs();
  const rec = buildRecord('01R');
  await store.store.put(apiKey.id, rec);
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/records/01R`, {
    headers: { 'x-api-key': apiKey.key },
  });
  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body, rec);
});

test('GET /api/dump/keys/:keyId/stream emits snapshot then appended', async () => {
  const { apiKey } = await setupAppTest();
  const { store, broker } = installStubs();
  await store.store.put(apiKey.id, buildRecord('01A'));
  await store.store.put(apiKey.id, buildRecord('01B'));

  const controller = new AbortController();
  const response = await requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
    signal: controller.signal,
  });
  assertEquals(response.status, 200);
  assertEquals(response.headers.get('content-type')?.startsWith('text/event-stream'), true);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  const readUntilEvent = async (event: string): Promise<{ event: string; data: string }> => {
    for (let i = 0; i < 100; i++) {
      const events = parseSSEText(buffer);
      const found = events.find(e => e.event === event);
      if (found) return found;
      const chunk = await reader.read();
      if (chunk.done) throw new Error(`stream ended before ${event}`);
      buffer += decoder.decode(chunk.value, { stream: true });
    }
    throw new Error(`gave up waiting for ${event}`);
  };

  const snapshot = await readUntilEvent('snapshot');
  const snapshotPayload = JSON.parse(snapshot.data) as DumpMetadata[];
  assertEquals(snapshotPayload.map(r => r.id), ['01B', '01A']);

  // The subscribe loop's first `next()` resolves on a microtask after the
  // snapshot SSE write returns; give it a turn before publishing.
  await new Promise(resolve => setTimeout(resolve, 10));
  broker.broker.publish(apiKey.id, buildRecord('01C').meta);

  const appended = await readUntilEvent('appended');
  const appendedPayload = JSON.parse(appended.data) as DumpMetadata;
  assertEquals(appendedPayload.id, '01C');

  controller.abort();
  await reader.cancel().catch(() => {});
});

test('cross-user ownership check applies to every dump endpoint', async () => {
  const { apiKey, adminSession } = await setupAppTest();
  installStubs();
  // adminSession belongs to user 1; apiKey belongs to user 2.
  const intruderHeaders = { 'x-floway-session': adminSession };
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records`, { headers: intruderHeaders })).status, 404);
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/records/anything`, { headers: intruderHeaders })).status, 404);
  assertEquals((await requestApp(`/api/dump/keys/${apiKey.id}/stream`, { headers: intruderHeaders })).status, 404);
});

// Subscribe runs before snapshot, so a record completing inside the snapshot
// window can be delivered by both paths; the client dedupes by id. The point
// of this test is to prove the at-worst-twice guarantee is honored — never
// dropped. We delay `list` to widen the window and publish during it.
test('GET /api/dump/keys/:keyId/stream — record completing during snapshot read is delivered (not lost)', async () => {
  const { apiKey } = await setupAppTest();
  const store = makeStubStore();
  const broker = makeBlockingBroker();

  let unblockList: (() => void) | null = null;
  const listGate = new Promise<void>(resolve => { unblockList = resolve; });
  const slowStore: DumpStore = {
    ...store.store,
    async list(keyId, opts) {
      await listGate;
      return await store.store.list(keyId, opts);
    },
  };
  initDumpStore(slowStore);
  initDumpBroker(broker.broker);

  await store.store.put(apiKey.id, buildRecord('01A'));

  const controller = new AbortController();
  const responsePromise = requestApp(`/api/dump/keys/${apiKey.id}/stream`, {
    headers: { 'x-api-key': apiKey.key },
    signal: controller.signal,
  });

  // Wait for the subscribe to attach (next microtask after the handler enters
  // the awaited list call); then publish a record that the snapshot won't
  // include because we put it after the list call's underlying data was
  // captured. Even so, the buffered subscription must deliver it.
  await new Promise(resolve => setTimeout(resolve, 10));
  await store.store.put(apiKey.id, buildRecord('01B'));
  broker.broker.publish(apiKey.id, buildRecord('01B').meta);
  unblockList!();

  const response = await responsePromise;
  assertEquals(response.status, 200);

  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  // Collect at least one snapshot + one appended frame.
  for (let i = 0; i < 200; i++) {
    const events = parseSSEText(buffer);
    if (events.some(e => e.event === 'snapshot') && events.some(e => e.event === 'appended')) break;
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
  }
  const events = parseSSEText(buffer);
  const snapshotEv = events.find(e => e.event === 'snapshot')!;
  const appendedEvs = events.filter(e => e.event === 'appended');
  const snapshotIds = (JSON.parse(snapshotEv.data) as DumpMetadata[]).map(r => r.id);
  const appendedIds = appendedEvs.map(e => (JSON.parse(e.data) as DumpMetadata).id);

  // 01B must appear at least once across snapshot+appended. Duplicates are
  // explicitly allowed by spec; the client dedupes by id.
  const seenIds = new Set([...snapshotIds, ...appendedIds]);
  assertEquals(seenIds.has('01B'), true);

  controller.abort();
  await reader.cancel().catch(() => {});
});
