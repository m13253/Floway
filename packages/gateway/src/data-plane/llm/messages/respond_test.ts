import { Hono } from 'hono';
import { test } from 'vitest';

import { createMessagesStreamUsageState, respondMessages, tokenUsageFromMessagesFrame } from './respond.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { FakeTime } from '../../../test-time.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { UPSTREAM_IDLE_TIMEOUT_MS } from '../shared/stream/sse.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, type ExecuteResult } from '@floway-dev/provider';
import { assert, assertEquals, assertStringIncludes, testTelemetryModelIdentity } from '@floway-dev/test-utils';

const stop = () => eventFrame({ type: 'message_stop' } satisfies MessagesStreamEvent);

test('Messages stream usage keeps start input and delta output', () => {
  const state = createMessagesStreamUsageState();

  // Every revising frame returns the running snapshot so the observer can
  // checkpoint partial usage into SourceStreamState before the terminal
  // message_stop — required for billing fidelity when the client disconnects
  // mid-stream.
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_start',
        message: {
          id: 'msg_1',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'claude-test',
          stop_reason: null,
          stop_sequence: null,
          usage: {
            input_tokens: 12,
            output_tokens: 1,
            cache_creation_input_tokens: 4,
            cache_read_input_tokens: 3,
          },
        },
      } satisfies MessagesStreamEvent),
      state,
    ),
    {
      input: 12,
      input_cache_read: 3,
      input_cache_write: 4,
      output: 1,
    },
  );
  assertEquals(
    tokenUsageFromMessagesFrame(
      eventFrame({
        type: 'message_delta',
        delta: {},
        usage: { output_tokens: 7 },
      } satisfies MessagesStreamEvent),
      state,
    ),
    {
      input: 12,
      input_cache_read: 3,
      input_cache_write: 4,
      output: 7,
    },
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 4,
    output: 7,
  });
});

test('Messages stream usage can recover input from delta', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 0 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: {
        input_tokens: 11,
        output_tokens: 2,
        cache_creation_input_tokens: 7,
        cache_read_input_tokens: 5,
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { output_tokens: 6 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 11,
    input_cache_read: 5,
    input_cache_write: 7,
    output: 6,
  });
});

test('Messages stream usage keeps cache-only start when a later delta carries input', () => {
  // A fully cache-hit prompt: message_start reports bare input 0 but non-zero
  // cache reads. A subsequent delta carries input_tokens, which must not cause
  // the start's cache counts to be dropped.
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 1000 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );
  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_delta',
      delta: {},
      usage: { input_tokens: 0, output_tokens: 50 },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input_cache_read: 1000,
    output: 50,
  });
});

test('Messages stream usage splits cache_creation per-TTL when the sub-object is present', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: {
          input_tokens: 12,
          output_tokens: 1,
          // The flat field is the sum of both sub-buckets and is consulted
          // only as a fallback. With the sub-object present the per-TTL split
          // must take precedence — otherwise this row would double-count.
          cache_creation_input_tokens: 9,
          cache_creation: { ephemeral_5m_input_tokens: 4, ephemeral_1h_input_tokens: 5 },
          cache_read_input_tokens: 3,
        },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 4,
    input_cache_write_1h: 5,
    output: 1,
  });
});

test('Messages stream usage falls back to the rolled-up cache_creation when the sub-object is absent', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-sonnet-4-6',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 12, output_tokens: 1, cache_creation_input_tokens: 9, cache_read_input_tokens: 3 },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 12,
    input_cache_read: 3,
    input_cache_write: 9,
    output: 1,
  });
});

test('Messages stream usage captures speed=fast as tier=fast', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'fast' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  assertEquals(tokenUsageFromMessagesFrame(stop(), state), {
    input: 5,
    tier: 'fast',
  });
});

test('Messages stream usage leaves tier unset when speed is standard', () => {
  const state = createMessagesStreamUsageState();

  tokenUsageFromMessagesFrame(
    eventFrame({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-opus-4-8',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0, speed: 'standard' },
      },
    } satisfies MessagesStreamEvent),
    state,
  );

  const usage = tokenUsageFromMessagesFrame(stop(), state);
  assertEquals(usage, { input: 5 });
});

// --- header forwarding ---

const ratelimitHeaders = (): Headers => new Headers({
  'anthropic-ratelimit-unified-status': 'allowed_warning',
  'anthropic-ratelimit-unified-fallback-percentage': '50',
  'x-internal-cache-id': 'cache-abc',
  'content-type': 'text/event-stream',
});

const makeRespondCtx = (): GatewayCtx => ({
  apiKeyId: 'key_respond_test',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'test',
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  currentColo: null,
});

const messagesEventsForRespond = (): readonly MessagesStreamEvent[] => [
  {
    type: 'message_start',
    message: {
      id: 'msg_1', type: 'message', role: 'assistant', content: [], model: 'claude-test',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 3, output_tokens: 0 },
    },
  },
  { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
  { type: 'content_block_stop', index: 0 },
  { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
  { type: 'message_stop' },
];

const messagesProtocolFrames = async function* (): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for (const event of messagesEventsForRespond()) yield eventFrame(event);
  yield doneFrame();
};

const callRespond = async (wantsStream: boolean): Promise<Response> => {
  initRepo(new InMemoryRepo());
  const app = new Hono();
  let captured: Response | undefined;
  app.get('/', async c => {
    const result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> = eventResult(
      messagesProtocolFrames(),
      testTelemetryModelIdentity,
      undefined,
      undefined,
      ratelimitHeaders(),
    );
    const { response } = await respondMessages(c, result, wantsStream, makeRespondCtx());
    captured = response;
    return response;
  });
  await app.request('/');
  if (!captured) throw new Error('respondMessages did not produce a Response');
  return captured;
};

test('respondMessages forwards anthropic-ratelimit-* headers on the non-streaming JSON response', async () => {
  const response = await callRespond(false);
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed_warning');
  assertEquals(response.headers.get('anthropic-ratelimit-unified-fallback-percentage'), '50');
  // The allowlist is by prefix — unrelated upstream headers must not be
  // proxied to the client.
  assertEquals(response.headers.get('x-internal-cache-id'), null);
});

test('respondMessages forwards anthropic-ratelimit-* headers on the streaming SSE response', async () => {
  const response = await callRespond(true);
  assertEquals(response.headers.get('anthropic-ratelimit-unified-status'), 'allowed_warning');
  assertEquals(response.headers.get('anthropic-ratelimit-unified-fallback-percentage'), '50');
  assertEquals(response.headers.get('x-internal-cache-id'), null);
  // Drain the body so the lazy generator releases its resources and the
  // background `finally` block in `streamSSE` doesn't keep the test runner
  // alive.
  await response.text();
});

// --- partial usage checkpointing on client disconnect ---

interface ControlledEvents {
  events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>;
  emit: (event: MessagesStreamEvent) => Promise<void>;
}

// A generator whose next() resolves only when emit() supplies the next event.
// Lets a test interleave "upstream emitted frame X" with "downstream cancels",
// so the streaming finally block fires while message_stop is still in flight.
const controlledMessagesEvents = (): ControlledEvents => {
  const queue: Array<MessagesStreamEvent> = [];
  const waiters: Array<(value: MessagesStreamEvent) => void> = [];
  const events: AsyncIterable<ProtocolFrame<MessagesStreamEvent>> = (async function* () {
    while (true) {
      const event = queue.shift() ?? (await new Promise<MessagesStreamEvent>(resolve => waiters.push(resolve)));
      yield eventFrame(event);
      if (event.type === 'message_stop') return;
    }
  })();
  return {
    events,
    emit: async event => {
      const waiter = waiters.shift();
      if (waiter) waiter(event);
      else queue.push(event);
      // Yield so the generator's `for await` consumer can advance past the
      // freshly-yielded frame before the test issues the next step.
      await Promise.resolve();
      await Promise.resolve();
    },
  };
};

test('respondMessages records the last observed message_delta usage when the client disconnects mid-stream', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const controlled = controlledMessagesEvents();
  const app = new Hono();
  app.get('/', c => {
    const result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> = eventResult(
      controlled.events,
      testTelemetryModelIdentity,
      undefined,
      undefined,
      new Headers({ 'content-type': 'text/event-stream' }),
    );
    const downstreamAbortController = new AbortController();
    const ctx: GatewayCtx = { ...makeRespondCtx(), wantsStream: true, downstreamAbortController };
    return respondMessages(c, result, true, ctx).then(({ response }) => response);
  });
  const response = await app.request('/');
  const reader = response.body!.getReader();

  await controlled.emit({
    type: 'message_start',
    message: {
      id: 'msg_abort', type: 'message', role: 'assistant', content: [], model: 'claude-test',
      stop_reason: null, stop_sequence: null,
      usage: { input_tokens: 20, output_tokens: 0 },
    },
  });
  await reader.read();
  await controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 5 } });
  await reader.read();
  await controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 11 } });
  await reader.read();
  await controlled.emit({ type: 'message_delta', delta: {}, usage: { output_tokens: 17 } });
  await reader.read();

  // Client disconnect before message_stop. The streamSSE finally block must
  // still record the latest message_delta's output count or the operator's
  // billing telemetry under-counts every aborted session.
  await reader.cancel();

  // The InMemoryRepo's recordTokenUsage is synchronous, but the finally block
  // runs after the cancellation propagates through streamSSE. A short poll
  // covers that hand-off without coupling the test to a fixed schedule.
  for (let i = 0; i < 20; i++) {
    if ((await repo.usage.listAll()).length > 0) break;
    await new Promise(resolve => setTimeout(resolve, 5));
  }

  const rows = await repo.usage.listAll();
  assertEquals(rows.length, 1);
  assertEquals(rows[0].tokens, { input: 20, output: 17 });
});

// --- upstream idle timeout ---

test('respondMessages aborts the upstream and surfaces an error frame when the SSE stream stalls', async () => {
  const time = new FakeTime();
  try {
    initRepo(new InMemoryRepo());
    const controlled = controlledMessagesEvents();
    const downstreamAbortController = new AbortController();
    const app = new Hono();
    app.get('/', c => {
      const result: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> = eventResult(
        controlled.events,
        testTelemetryModelIdentity,
        undefined,
        undefined,
        new Headers({ 'content-type': 'text/event-stream' }),
      );
      const ctx: GatewayCtx = { ...makeRespondCtx(), wantsStream: true, downstreamAbortController };
      return respondMessages(c, result, true, ctx).then(({ response }) => response);
    });
    const response = await app.request('/');
    const reader = response.body!.getReader();

    // First frame lands normally, so the stream is fully open.
    await controlled.emit({
      type: 'message_start',
      message: {
        id: 'msg_idle', type: 'message', role: 'assistant', content: [], model: 'claude-test',
        stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 5, output_tokens: 0 },
      },
    });
    const firstRead = await reader.read();
    assert(!firstRead.done);
    const firstChunk = new TextDecoder().decode(firstRead.value);
    assertStringIncludes(firstChunk, 'event: message_start');

    // Upstream goes silent. The downstream keepalive emits pings every 15s
    // while the upstream wrapper waits out the 60s idle window. After the
    // window the wrapper must abort the downstreamAbortController and emit
    // a synthetic error frame so the client sees a clean failure instead
    // of a hung socket.
    const decoder = new TextDecoder();
    const collected: string[] = [];
    const drainUntilError = (async () => {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) return;
        const text = decoder.decode(chunk.value);
        collected.push(text);
        if (text.includes('event: error')) return;
      }
    })();
    await time.tickAsync(UPSTREAM_IDLE_TIMEOUT_MS + 100);
    await drainUntilError;
    const joined = collected.join('');
    assertStringIncludes(joined, 'event: error');
    assertStringIncludes(joined, 'UpstreamIdleTimeoutError');
    assert(downstreamAbortController.signal.aborted, 'idle timeout should abort the upstream');

    await reader.cancel();
  } finally {
    time.restore();
  }
});
