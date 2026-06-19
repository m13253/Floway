import { Hono } from 'hono';
import { beforeEach, describe, expect, test, vi } from 'vitest';

import { captureRequestDump } from './capture-dump.ts';
import { getRepo, initRepo } from '../../repo/index.ts';
import { InMemoryRepo } from '../../repo/memory.ts';
import type { ApiKey } from '../../repo/types.ts';
import { initBackgroundSchedulerResolver } from '../../runtime/background.ts';
import { initDumpBroker, initDumpStore } from '../../runtime/dump.ts';
import type { DumpBroker, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord } from '@floway-dev/protocols/dump';
import type { UpstreamRecord } from '@floway-dev/provider';
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

const seedUpstream = (overrides: Partial<UpstreamRecord> = {}): UpstreamRecord => ({
  id: 'up_test',
  provider: 'custom',
  name: 'Test Upstream',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-19T00:00:00.000Z',
  updatedAt: '2026-06-19T00:00:00.000Z',
  config: {},
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
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
    async *subscribe() {},
  };
  return { publishes, broker };
};

interface CaptureVars {
  apiKey: ApiKey;
  dumpAccounting: { upstream: string | null; model: string | null; inputTokens: number | null; outputTokens: number | null };
}

const makeApp = (apiKey: ApiKey): Hono<{ Variables: CaptureVars }> => {
  const app = new Hono<{ Variables: CaptureVars }>();
  app.use('*', async (c, next) => {
    c.set('apiKey', apiKey);
    await next();
  });
  app.use('*', captureRequestDump());
  return app;
};

let stubStore: ReturnType<typeof makeStubStore>;
let stubBroker: ReturnType<typeof makeStubBroker>;
let scheduled: Promise<unknown>[];
let scheduledErrors: unknown[];

beforeEach(() => {
  stubStore = makeStubStore();
  stubBroker = makeStubBroker();
  scheduled = [];
  scheduledErrors = [];
  initRepo(new InMemoryRepo());
  initDumpStore(stubStore.store);
  initDumpBroker(stubBroker.broker);
  initBackgroundSchedulerResolver(_c => promise => {
    scheduled.push(promise);
    promise.catch(err => { scheduledErrors.push(err); });
  });
});

// Wait for the fire-and-forget scheduler queue to flush. The test scheduler
// captures every scheduled promise into `scheduled`; this just awaits them
// in order, including any that get re-scheduled during finalize. Uses
// allSettled so a deliberately-failing test doesn't poison the drain.
const drainScheduled = async (): Promise<void> => {
  while (scheduled.length > 0) {
    const pending = scheduled;
    scheduled = [];
    await Promise.allSettled(pending);
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
  await getRepo().upstreams.save(seedUpstream({ id: 'up_test', name: 'Test Upstream', provider: 'custom' }));

  const app = makeApp(apiKeyWithDump());
  app.use('/v1/messages', async (c, next) => {
    c.set('dumpAccounting', { upstream: 'up_test', model: 'mod_test', inputTokens: 12, outputTokens: 7 });
    await next();
  });
  app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

  await app.request('/v1/messages', { method: 'POST', body: '{}' });
  await drainScheduled();

  const meta = stubStore.puts[0]!.record.meta;
  assertEquals(meta.upstream, { id: 'up_test', name: 'Test Upstream', kind: 'custom' });
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

// The request body is tee'd, not buffered to memory. The downstream
// handler must see request bytes streaming in as they arrive; the capture
// drains its half concurrently. This test sends chunks separated by an
// await turn and asserts the handler observed each chunk before EOF, and
// that the capture buffer reassembled the same bytes.
test('streaming request body reaches the handler chunk-by-chunk and the capture buffer reassembles it', async () => {
  const app = makeApp(apiKeyWithDump());
  const observedChunks: string[] = [];
  app.post('/echo', async c => {
    const reader = c.req.raw.body!.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      observedChunks.push(decoder.decode(value));
    }
    return new Response('done', { status: 200, headers: { 'content-type': 'text/plain' } });
  });

  // Build a request body that pushes one chunk, awaits a microtask, then
  // pushes the next chunk and closes. If the middleware buffers the body
  // before calling next(), the handler sees the full body in one read; if
  // it tees, the handler sees the chunks separately.
  const chunks = ['{"part":"one",', '"part":"two"}'];
  const body = new ReadableStream<Uint8Array>({
    async start(controller) {
      controller.enqueue(new TextEncoder().encode(chunks[0]!));
      await new Promise(resolve => setTimeout(resolve, 5));
      controller.enqueue(new TextEncoder().encode(chunks[1]!));
      controller.close();
    },
  });
  const response = await app.request('/echo', {
    method: 'POST',
    body,
    headers: { 'content-type': 'application/json' },
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
  assertEquals(response.status, 200);
  await drainScheduled();

  // The handler observed at least two separate reads — proves the body was
  // streaming, not pre-buffered into a single Uint8Array.
  expect(observedChunks.length).toBeGreaterThanOrEqual(2);
  assertEquals(observedChunks.join(''), chunks.join(''));

  // The capture buffer reassembled the same bytes.
  const record = stubStore.puts[0]!.record;
  assertEquals(record.request.body, chunks.join(''));
});

describe('failure modes', () => {
  // The middleware wraps store/broker failures with a `[dump] keyId=… recordId=…`
  // prefix so the scheduler's logger anchors the failure to the dump it tried
  // to write. The wrap must preserve the original error as `cause`.
  test('store.put failure surfaces with the [dump] keyId/recordId wrap and preserves the original error chain', async () => {
    const cause = new Error('write failed');
    initDumpStore({
      ...stubStore.store,
      put: async () => { throw cause; },
    });
    const app = makeApp(apiKeyWithDump());
    app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    await app.request('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await drainScheduled();

    assertEquals(scheduledErrors.length, 1);
    const err = scheduledErrors[0];
    expect(err).toBeInstanceOf(Error);
    expect((err as Error).message).toMatch(/^\[dump\] keyId=key_dumped recordId=.+: write failed$/);
    assertEquals((err as Error & { cause?: unknown }).cause, cause);
    // The broker is never reached when put throws.
    assertEquals(stubBroker.publishes.length, 0);
  });

  test('broker.publish failure surfaces with the same [dump] keyId/recordId wrap', async () => {
    const cause = new Error('publish failed');
    initDumpBroker({
      ...stubBroker.broker,
      publish: () => { throw cause; },
    });
    const app = makeApp(apiKeyWithDump());
    app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    await app.request('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await drainScheduled();

    // Store.put succeeded before the broker throw — the partial work is on disk.
    assertEquals(stubStore.puts.length, 1);
    assertEquals(scheduledErrors.length, 1);
    const err = scheduledErrors[0] as Error & { cause?: unknown };
    expect(err.message).toMatch(/^\[dump\] keyId=key_dumped recordId=.+: publish failed$/);
    assertEquals(err.cause, cause);
  });

  // A repo throw on upstream-ref lookup must degrade to a fallback ref
  // rather than drop the entire dump — a transient lookup failure shouldn't
  // lose the record. The capture middleware also logs via console.error so
  // the operator can distinguish "upstream deleted" from "repo down"; the
  // spy below absorbs that expected log line.
  test('upstream-ref lookup failure degrades gracefully — the record still persists with a fallback ref', async () => {
    const repo = new InMemoryRepo();
    repo.upstreams = {
      ...repo.upstreams,
      getById: async () => { throw new Error('repo down'); },
    };
    initRepo(repo);
    const app = makeApp(apiKeyWithDump());
    app.use('/v1/messages', async (c, next) => {
      c.set('dumpAccounting', { upstream: 'up_unreachable', model: 'm', inputTokens: 1, outputTokens: 2 });
      await next();
    });
    app.post('/v1/messages', () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } }));

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await app.request('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
      await drainScheduled();

      assertEquals(scheduledErrors.length, 0);
      assertEquals(stubStore.puts.length, 1);
      const meta = stubStore.puts[0]!.record.meta;
      assertEquals(meta.upstream, { id: 'up_unreachable', name: 'up_unreachable', kind: 'unknown' });
      // Lookup failure is observable: operator sees the upstream id and the
      // underlying error rather than a silent fallback.
      assertEquals(errorSpy.mock.calls[0]![0], '[dump] upstream lookup failed');
      assertEquals(errorSpy.mock.calls[0]![1], 'up_unreachable');
      expect((errorSpy.mock.calls[0]![2] as Error).message).toBe('repo down');
    } finally {
      errorSpy.mockRestore();
    }
  });

  test('captureBytes mid-stream error preserves the bytes received so far in meta.error', async () => {
    const app = makeApp(apiKeyWithDump());
    app.post('/v1/messages', () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('partial-'));
          // Yield so the teed readers can dequeue the first chunk before the
          // error lands — proves the reader-loop captured what arrived even
          // though the stream eventually errored.
          await new Promise(resolve => setTimeout(resolve, 5));
          controller.enqueue(new TextEncoder().encode('payload-'));
          await new Promise(resolve => setTimeout(resolve, 5));
          controller.error(new Error('upstream cut us off'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'application/json' } });
    });

    const response = await app.request('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    // Drain the client side; an error mid-stream is propagated by the body
    // reader, which we catch so the test continues past the response handoff.
    await response.text().catch(() => {});
    await drainScheduled();

    assertEquals(stubStore.puts.length, 1);
    const record = stubStore.puts[0]!.record;
    if (record.response.type !== 'bytes') throw new Error('expected bytes');
    // Partial buffered payload is preserved — this is the whole point of
    // the reader-loop capture: arrayBuffer() would have discarded both
    // chunks on the error.
    assertEquals(record.response.body, 'partial-payload-');
    expect(record.meta.error).toMatch(/upstream cut us off/);
  });

  test('captureSSE mid-stream error keeps already-parsed frames and surfaces the error in meta.error', async () => {
    const app = makeApp(apiKeyWithDump());
    app.post('/v1/messages', () => {
      const stream = new ReadableStream<Uint8Array>({
        async start(controller) {
          controller.enqueue(new TextEncoder().encode('event: start\ndata: hello\n\n'));
          await new Promise(resolve => setTimeout(resolve, 5));
          controller.enqueue(new TextEncoder().encode('event: mid\ndata: world\n\n'));
          await new Promise(resolve => setTimeout(resolve, 5));
          controller.error(new Error('upstream sse blew up'));
        },
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    });

    const response = await app.request('/v1/messages', { method: 'POST', body: '{}', headers: { 'content-type': 'application/json' } });
    await response.text().catch(() => {});
    await drainScheduled();

    assertEquals(stubStore.puts.length, 1);
    const record = stubStore.puts[0]!.record;
    if (record.response.type !== 'stream') throw new Error('expected stream');
    // Frames the parser successfully consumed before the error must survive
    // so the dump can show what arrived ahead of the failure.
    assertEquals(record.response.events.length, 2);
    assertEquals(record.response.events[0]!.data, 'hello');
    assertEquals(record.response.events[1]!.data, 'world');
    expect(record.meta.error).toMatch(/upstream sse blew up/);
  });
});
