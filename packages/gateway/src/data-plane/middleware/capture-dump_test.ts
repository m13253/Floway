import { Hono } from 'hono';
import { beforeEach, expect, test } from 'vitest';

import { captureRequestDump } from './capture-dump.ts';
import type { ApiKey } from '../../repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../runtime/background.ts';
import { initDumpBroker, initDumpStore } from '../../runtime/dump.ts';
import type { DumpBroker, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

const apiKeyWithDump = (overrides: Partial<ApiKey> = {}): ApiKey => ({
  id: 'key_dumped',
  userId: 1,
  name: 'k',
  key: 'raw',
  createdAt: '2026-06-19T00:00:00.000Z',
  upstreamIds: null,
  deletedAt: null,
  dumpRetentionSeconds: 3600,
  ...overrides,
});

interface RecordedPut { keyId: string; record: DumpRecord }
interface RecordedPublish { keyId: string; meta: DumpMetadata }

const makeStubStore = (): { puts: RecordedPut[]; store: DumpStore } => {
  const puts: RecordedPut[] = [];
  const store: DumpStore = {
    put: async (keyId, record) => { puts.push({ keyId, record }); },
    list: async () => [],
    get: async () => null,
    purgeExpired: async () => {},
    purgeAll: async () => {},
  };
  return { puts, store };
};

const makeStubBroker = (): { publishes: RecordedPublish[]; broker: DumpBroker } => {
  const publishes: RecordedPublish[] = [];
  const broker: DumpBroker = {
    publish: (keyId, meta) => { publishes.push({ keyId, meta }); },
    async *subscribe() { /* no-op for tests */ },
  };
  return { publishes, broker };
};

interface CaptureVars {
  apiKey: ApiKey;
  dumpAccounting: { upstream: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null };
}

const makeApp = (apiKey: ApiKey | undefined): Hono<{ Variables: CaptureVars }> => {
  const app = new Hono<{ Variables: CaptureVars }>();
  app.use('*', async (c, next) => {
    if (apiKey) c.set('apiKey', apiKey);
    await next();
  });
  app.use('*', captureRequestDump());
  return app;
};

// Wait for the fire-and-forget scheduler queue to flush. The test scheduler
// captures every scheduled promise into `scheduled`; this just awaits them
// in order, including any that get re-scheduled during finalize.

let stubStore: ReturnType<typeof makeStubStore>;
let stubBroker: ReturnType<typeof makeStubBroker>;
let scheduled: Promise<unknown>[];

beforeEach(() => {
  stubStore = makeStubStore();
  stubBroker = makeStubBroker();
  scheduled = [];
  initDumpStore(stubStore.store);
  initDumpBroker(stubBroker.broker);
  initBackgroundSchedulerResolver(_c => promise => {
    scheduled.push(promise);
    promise.catch(err => console.error('[bg-test]', err));
  });
});

const drainScheduled = async (): Promise<void> => {
  while (scheduled.length > 0) {
    const pending = scheduled;
    scheduled = [];
    await Promise.all(pending);
  }
};

test('SSE upstream is captured frame-by-frame as a stream record', async () => {
  const app = makeApp(apiKeyWithDump());
  app.post('/v1/messages', () => {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('event: start\ndata: hello\n\n'));
        controller.enqueue(new TextEncoder().encode('event: stop\ndata: world\n\n'));
        controller.close();
      },
    });
    return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
  });

  const response = await app.request('/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{"x":1}',
  });

  // Drain the client side so the tee'd capture side completes.
  assertEquals(response.status, 200);
  await response.text();
  await drainScheduled();

  assertEquals(stubStore.puts.length, 1);
  const record = stubStore.puts[0]!.record;
  assertEquals(record.response.type, 'stream');
  if (record.response.type !== 'stream') throw new Error('expected stream');
  assertEquals(record.response.events.length, 2);
  assertEquals(record.response.events[0]!.event, 'start');
  assertEquals(record.response.events[0]!.data, 'hello');
  assertEquals(record.response.events[1]!.event, 'stop');
  assertEquals(record.response.events[1]!.data, 'world');
  assertEquals(stubBroker.publishes.length, 1);
});

test('JSON upstream is captured verbatim as bytes', async () => {
  const app = makeApp(apiKeyWithDump());
  const payload = '{"ok":true,"n":42}';
  app.post('/v1/embeddings', () =>
    new Response(payload, { status: 200, headers: { 'content-type': 'application/json' } }));

  const response = await app.request('/v1/embeddings', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await response.text();
  await drainScheduled();

  const record = stubStore.puts[0]!.record;
  assertEquals(record.response.type, 'bytes');
  if (record.response.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(record.response.body, payload);
});

test('downstream handler reads the request body via the tee-replay', async () => {
  const app = makeApp(apiKeyWithDump());
  let observed = '';
  app.post('/echo', async c => {
    observed = await c.req.text();
    return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
  });

  const body = '{"replay":"yes"}';
  await app.request('/echo', { method: 'POST', body, headers: { 'content-type': 'application/json' } });
  await drainScheduled();

  assertEquals(observed, body);
  const record = stubStore.puts[0]!.record;
  assertEquals(record.request.body, body);
});

test('upstream throw produces a none-body record with status 0 and a non-empty error', async () => {
  const app = makeApp(apiKeyWithDump());
  app.post('/v1/messages', () => { throw new Error('upstream blew up'); });

  // Hono catches the rethrown error in its outer error handler and returns
  // 500 to the client, but the dump record still captures status 0 / no body
  // because no response was produced before the throw.
  const response = await app.request('/v1/messages', { method: 'POST', body: '{}' });
  assertEquals(response.status, 500);
  await drainScheduled();

  const record = stubStore.puts[0]!.record;
  assertEquals(record.response.type, 'none');
  assertEquals(record.meta.status, 0);
  expect(record.meta.error).toMatch(/blew up/);
});

test('apiKey with null retention is a pass-through; nothing is stored or published', async () => {
  const app = makeApp(apiKeyWithDump({ dumpRetentionSeconds: null }));
  app.post('/v1/messages', () => new Response('{"ok":true}', { status: 200, headers: { 'content-type': 'application/json' } }));

  const response = await app.request('/v1/messages', { method: 'POST', body: '{}' });
  await response.text();
  await drainScheduled();

  assertEquals(response.status, 200);
  assertEquals(stubStore.puts.length, 0);
  assertEquals(stubBroker.publishes.length, 0);
});

test('absent apiKey context var is a pass-through (e.g. dashboard / non-dump-eligible routes)', async () => {
  const app = makeApp(undefined);
  app.post('/api/anything', () => new Response('ok', { status: 200 }));

  const response = await app.request('/api/anything', { method: 'POST' });
  await response.text();
  await drainScheduled();

  assertEquals(response.status, 200);
  assertEquals(stubStore.puts.length, 0);
});

test('headers are captured verbatim — no redaction of authorization / x-api-key / cookie', async () => {
  const app = makeApp(apiKeyWithDump());
  app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

  await app.request('/v1/messages', {
    method: 'POST',
    body: '{}',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer sk-secret-do-not-redact',
      'x-api-key': 'raw-key-value',
      'cookie': 'session=abcdef',
    },
  });
  await drainScheduled();

  const record = stubStore.puts[0]!.record;
  const headerMap = Object.fromEntries(record.request.headers.map(([k, v]) => [k.toLowerCase(), v]));
  assertEquals(headerMap['authorization'], 'Bearer sk-secret-do-not-redact');
  assertEquals(headerMap['x-api-key'], 'raw-key-value');
  assertEquals(headerMap['cookie'], 'session=abcdef');
});

test('dumpAccounting context var feeds the record metadata', async () => {
  const app = makeApp(apiKeyWithDump());
  app.use('/v1/messages', async (c, next) => {
    c.set('dumpAccounting', { upstream: 'up_test', model: 'mod_test', inputTokens: 12, outputTokens: 7 });
    await next();
  });
  app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

  await app.request('/v1/messages', { method: 'POST', body: '{}' });
  await drainScheduled();

  const meta = stubStore.puts[0]!.record.meta;
  assertEquals(meta.upstream, 'up_test');
  assertEquals(meta.model, 'mod_test');
  assertEquals(meta.inputTokens, 12);
  assertEquals(meta.outputTokens, 7);
});

test('absent dumpAccounting leaves metadata fields null without inventing defaults', async () => {
  const app = makeApp(apiKeyWithDump());
  app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

  await app.request('/v1/messages', { method: 'POST', body: '{}' });
  await drainScheduled();

  const meta = stubStore.puts[0]!.record.meta;
  assertEquals(meta.upstream, null);
  assertEquals(meta.model, null);
  assertEquals(meta.inputTokens, null);
  assertEquals(meta.outputTokens, null);
});

test('non-text response body round-trips through base64 with a ;base64 suffix on the recorded content-type', async () => {
  const app = makeApp(apiKeyWithDump());
  const bytes = new Uint8Array([0xFF, 0xD8, 0xFF, 0xE0]);
  app.post('/v1/images/generations', () =>
    new Response(bytes, { status: 200, headers: { 'content-type': 'image/jpeg' } }));

  await app.request('/v1/images/generations', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
  await drainScheduled();

  const record = stubStore.puts[0]!.record;
  assertEquals(record.response.type, 'bytes');
  if (record.response.type !== 'bytes') throw new Error('expected bytes');
  // Body is plain base64; the ;base64 suffix lives on the recorded content type.
  assertEquals(record.response.body, btoa('\xFF\xD8\xFF\xE0'));
  const ct = record.response.headers.find(([k]) => k.toLowerCase() === 'content-type');
  assertEquals(ct?.[1], 'image/jpeg;base64');
});
