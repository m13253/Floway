
import type { Context } from 'hono';
import { Hono } from 'hono';
import { test } from 'vitest';

import { type DumpAccounting, captureRequestDump, errorDumpAccounting, plainDumpAccounting, setDumpAccountingFromIdentity } from './capture-dump.ts';
import type { ApiKey } from '../../repo/types.ts';
import { setDumpBroker, setDumpStore } from '../../runtime/dump.ts';
import { setupAppTest } from '../../test-helpers.ts';
import type { DumpBroker, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// The capture middleware reads `apiKey` and `dumpAccounting` off the Hono
// context. The default Hono Variables map is empty; widen it locally so
// `c.set(...)` typechecks in the test wiring.
type TestVars = { apiKey: ApiKey; dumpAccounting: DumpAccounting };

// A minimal in-memory pair of store + broker we can swap into the runtime
// just for these tests. Reset on every test so a previous capture doesn't
// leak into the next one — vitest runs files in isolated workers but tests
// in the same file share module state.
const installStubs = () => {
  const stored: Array<{ keyId: string; record: DumpRecord }> = [];
  const published: Array<{ keyId: string; meta: DumpMetadata }> = [];
  let putThrows: Error | null = null;
  let publishThrows: Error | null = null;

  const store: DumpStore = {
    async put(keyId, record) {
      if (putThrows) throw putThrows;
      stored.push({ keyId, record });
    },
    async list() { return stored.map(s => s.record.meta); },
    async get() { return null; },
    async purgeAll() { /* noop */ },
    async purgeExpired() { /* noop */ },
  };
  const broker: DumpBroker = {
    async publish(keyId, meta) {
      if (publishThrows) throw publishThrows;
      published.push({ keyId, meta });
    },
    async notifyDisabled() { /* noop */ },
    subscribe() { return (async function*() {})(); },
  };
  setDumpStore(store);
  setDumpBroker(broker);
  return {
    stored,
    published,
    failPut(err: Error) { putThrows = err; },
    failPublish(err: Error) { publishThrows = err; },
  };
};

const buildApp = (setApiKey: (c: Context<{ Variables: TestVars }>) => void) => {
  const app = new Hono<{ Variables: TestVars }>();
  // Mirror production: auth-style middleware stamps c.set('apiKey', ...)
  // BEFORE the capture-dump middleware reads it. The test handler can then
  // own only the response shape + dumpAccounting stamp.
  app.use('*', async (c, next) => {
    setApiKey(c);
    await next();
  });
  app.use('*', captureRequestDump());
  return app;
};

const flushBackground = async (): Promise<void> => {
  for (let i = 0; i < 20; i++) {
    await new Promise(resolve => setTimeout(resolve, 5));
  }
};

test('captureRequestDump short-circuits when the key has no retention', async () => {
  const { apiKey } = await setupAppTest();
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', apiKey));
  app.get('/v1/test', c => c.json({ ok: true }));

  const response = await app.request('/v1/test');
  assertEquals(response.status, 200);
  await flushBackground();
  assertEquals(stubs.stored.length, 0);
  assertEquals(stubs.published.length, 0);
});

test('captureRequestDump records a JSON request and JSON response on a retention-enabled key', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/chat/completions', async c => {
    c.set('dumpAccounting', plainDumpAccounting);
    return c.json({ id: 'resp', choices: [] });
  });

  const response = await app.request('/v1/chat/completions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'm', messages: [{ role: 'user', content: 'hi' }] }),
  });
  assertEquals(response.status, 200);
  await response.text();
  await flushBackground();

  assertEquals(stubs.stored.length, 1);
  assertEquals(stubs.published.length, 1);
  const record = stubs.stored[0]!.record;
  assertEquals(record.meta.method, 'POST');
  assertEquals(record.meta.path, '/v1/chat/completions');
  assertEquals(record.meta.status, 200);
  assertEquals(record.response.type, 'bytes');
  assertEquals(record.request.body.includes('"role":"user"'), true);
});

test('captureRequestDump publishes only after store.put resolves', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  const order: string[] = [];
  const store: DumpStore = {
    async put() { order.push('put-start'); await new Promise(r => setTimeout(r, 10)); order.push('put-end'); },
    async list() { return []; },
    async get() { return null; },
    async purgeAll() { /* noop */ },
    async purgeExpired() { /* noop */ },
  };
  const broker: DumpBroker = {
    async publish() { order.push('publish'); },
    async notifyDisabled() { /* noop */ },
    subscribe() { return (async function*() {})(); },
  };
  setDumpStore(store);
  setDumpBroker(broker);

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/x', async c => {
    c.set('dumpAccounting', plainDumpAccounting);
    return c.json({ ok: 1 });
  });
  const response = await app.request('/v1/x', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await flushBackground();

  assertEquals(order, ['put-start', 'put-end', 'publish']);
});

test('captureRequestDump surfaces accounting.error onto meta.error', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/err', async c => {
    errorDumpAccounting(c, new Error('upstream blew up'));
    return c.json({ error: 'oops' }, 502);
  });
  const response = await app.request('/v1/err', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await flushBackground();

  assertEquals(stubs.stored.length, 1);
  assertEquals(stubs.stored[0]!.record.meta.error, 'upstream blew up');
  assertEquals(stubs.stored[0]!.record.meta.status, 502);
});

test('captureRequestDump records identity-derived model + upstream on success', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  await repo.upstreams.save({
    id: 'up_test', provider: 'custom', name: 'Test Upstream', enabled: true, sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z', updatedAt: '2026-03-15T00:00:00.000Z',
    config: { baseUrl: 'https://x', bearerToken: 't', endpoints: { chatCompletions: {} } },
    state: null, flagOverrides: {}, disabledPublicModelIds: [], proxyFallbackList: [],
  });
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/y', async c => {
    setDumpAccountingFromIdentity(c, { model: 'm-1', upstream: 'up_test', modelKey: 'mk', cost: null }, { input: 100, output: 50 });
    return c.json({ data: 'ok' });
  });
  const response = await app.request('/v1/y', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await flushBackground();

  assertEquals(stubs.stored.length, 1);
  const meta = stubs.stored[0]!.record.meta;
  assertExists(meta.upstream);
  assertEquals(meta.upstream!.id, 'up_test');
  assertEquals(meta.upstream!.name, 'Test Upstream');
  assertEquals(meta.upstream!.kind, 'custom');
  assertEquals(meta.model, 'm-1');
  assertEquals(meta.inputTokens, 100);
  assertEquals(meta.outputTokens, 50);
});

test('captureRequestDump falls back to placeholder upstream ref when lookup throws', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  const originalGetById = repo.upstreams.getById.bind(repo.upstreams);
  repo.upstreams.getById = async () => { throw new Error('db down'); };
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/z', async c => {
    setDumpAccountingFromIdentity(c, { model: 'm', upstream: 'up_ghost', modelKey: 'mk', cost: null }, null);
    return c.json({});
  });
  const response = await app.request('/v1/z', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await flushBackground();

  repo.upstreams.getById = originalGetById;

  assertEquals(stubs.stored.length, 1);
  const upstream = stubs.stored[0]!.record.meta.upstream;
  assertExists(upstream);
  assertEquals(upstream!.id, 'up_ghost');
  assertEquals(upstream!.name, 'up_ghost');
  assertEquals(upstream!.kind, 'unknown');
});

test('captureRequestDump captures SSE response as parsed events', async () => {
  const { repo, apiKey } = await setupAppTest();
  const enabledKey = { ...apiKey, dumpRetentionSeconds: 3600 };
  await repo.apiKeys.save(enabledKey);
  const stubs = installStubs();

  const app = buildApp(c => c.set('apiKey', enabledKey));
  app.post('/v1/stream', async c => {
    c.set('dumpAccounting', plainDumpAccounting);
    return new Response('event: ping\ndata: hello\n\nevent: ping\ndata: world\n\n', {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  });
  const response = await app.request('/v1/stream', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await flushBackground();

  assertEquals(stubs.stored.length, 1);
  const responseField = stubs.stored[0]!.record.response;
  assertEquals(responseField.type, 'stream');
  if (responseField.type !== 'stream') throw new Error('expected stream');
  assertEquals(responseField.events.length, 2);
  assertEquals(responseField.events[0]!.data, 'hello');
  assertEquals(responseField.events[1]!.data, 'world');
});
