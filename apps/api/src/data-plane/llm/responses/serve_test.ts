import { test, vi } from 'vitest';

import { createStoredResponsesItemId } from './items/format.ts';
import { createResponsesHttpStore, MemoryStatefulResponsesBacking, LayeredStatefulResponsesStore } from './items/store.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem, StoredResponsesSnapshot } from '../../../repo/types.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assert, assertEquals, stubProvider, stubUpstreamModel } from '@floway-dev/test-utils';

// `enumerateProviderCandidates` is the only seam between serve and the
// provider registry — mocking it directly keeps the serve tests narrow
// (no fake fetch, no repo upstream rows for provider catalogs) and lets
// each test hand the serve exactly the candidates it wants to exercise.
const candidatesQueue: { readonly candidates: readonly ProviderCandidate[] }[] = [];
vi.mock('../shared/candidates.ts', async importOriginal => {
  const original = await importOriginal<typeof import('../shared/candidates.ts')>();
  return {
    ...original,
    enumerateProviderCandidates: vi.fn(async () => {
      const next = candidatesQueue.shift();
      if (next === undefined) throw new Error('serve_test: no candidates enqueued');
      return next.candidates;
    }),
  };
});

const { responsesServe } = await import('./serve.ts');
const { expandPreviousResponseId } = await import('./serve-prep.ts');

const API_KEY_ID = 'key_serve_test';

const queueCandidates = (candidates: readonly ProviderCandidate[]): void => {
  candidatesQueue.push({ candidates });
};

const installRepo = (): InMemoryRepo => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  return repo;
};

const makeGatewayCtx = (): GatewayCtx => ({
  apiKeyId: API_KEY_ID,
  apiKeyUpstreamIds: null,
  headers: new Headers(),
  wantsStream: true,
  scheduleBackground: () => {},
  requestStartedAt: 0,
});

const makePayload = (overrides: Partial<ResponsesPayload> = {}): ResponsesPayload => ({
  model: 'test-model',
  input: 'hello',
  ...overrides,
});

const makeResponsesResult = (id = 'resp_test'): ResponsesResult => ({
  id,
  object: 'response',
  model: 'test-model',
  status: 'completed',
  output: [{
    type: 'message',
    id: 'msg_1',
    role: 'assistant',
    status: 'completed',
    content: [{ type: 'output_text', text: 'hi' }],
  }],
  output_text: 'hi',
  error: null,
  incomplete_details: null,
});

const makeProviderEvents = async function* (events: readonly ResponsesStreamEvent[]): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeCandidate = (overrides: {
  upstream?: string;
  targetApi?: ProviderCandidate['targetApi'];
  callResponses?: (model: unknown, body: unknown, signal?: AbortSignal, headers?: Record<string, string>) => Promise<ProviderStreamResult<ResponsesStreamEvent>>;
  callResponsesCompact?: (...args: unknown[]) => Promise<unknown>;
} = {}): ProviderCandidate => {
  const upstream = overrides.upstream ?? 'up_test';
  const targetApi = overrides.targetApi ?? 'responses';
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({
    callResponses: overrides.callResponses,
    ...(overrides.callResponsesCompact !== undefined ? { callResponsesCompact: overrides.callResponsesCompact as never } : {}),
  });
  return {
    provider: {
      upstream,
      providerKind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      provider,
      supportsResponsesItemReference: true,
    },
    binding: {
      upstream,
      upstreamName: upstream,
      providerKind: 'custom',
      provider,
      upstreamModel,
      enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi,
  };
};

const collectEvents = async (events: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>): Promise<ResponsesStreamEvent[]> => {
  const out: ResponsesStreamEvent[] = [];
  for await (const frame of events) {
    if (frame.type === 'event') out.push(frame.event);
  }
  return out;
};

test('generate routes a native Responses candidate end to end', async () => {
  installRepo();
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult(),
  };
  const callResponses = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true,
    events: makeProviderEvents([completed]),
    modelKey: 'test-model-key',
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callResponses });
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  const events = await collectEvents(result.events);
  assert(events.length >= 1);
  assertEquals(callResponses.mock.calls.length, 1);
});

test('compact returns a result envelope from the wrapped attempt', async () => {
  installRepo();
  const compactionItem = { type: 'compaction' as const, id: 'cmp_1', encrypted_content: 'ENC' };
  const compactionResult: ResponsesResult = {
    ...makeResponsesResult(),
    object: 'response.compaction',
    output: [compactionItem] as unknown as ResponsesResult['output'],
  };
  const callResponsesCompact = vi.fn(async () => ({
    ok: true as const,
    result: compactionResult,
    modelKey: 'test-model-key',
  }));
  const candidate = makeCandidate({ upstream: 'up_a', callResponsesCompact });
  queueCandidates([candidate]);

  const result = await responsesServe.compact({
    payload: makePayload({ input: [{ type: 'message', role: 'user', content: 'kept' }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'result');
  if (result.type !== 'result') throw new Error('unreachable');
  assertEquals(result.result.object, 'response.compaction');
  assertEquals(callResponsesCompact.mock.calls.length, 1);
});

test('generate stops at the first candidate even when it yields an upstream error', async () => {
  installRepo();
  const firstError = new Response(JSON.stringify({ error: { message: 'nope' } }), {
    status: 502, headers: { 'content-type': 'application/json' },
  });
  const firstCall = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: false, response: firstError, modelKey: 'first-key',
  }));
  const completed: ResponsesStreamEvent = {
    type: 'response.completed',
    sequence_number: 0,
    response: makeResponsesResult('resp_second'),
  };
  const secondCall = vi.fn(async (): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: true, events: makeProviderEvents([completed]), modelKey: 'second-key',
  }));
  const first = makeCandidate({ upstream: 'up_a', callResponses: firstCall });
  const second = makeCandidate({ upstream: 'up_b', callResponses: secondCall });
  queueCandidates([first, second]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  // An upstream error from the first candidate IS the final answer — the
  // gateway does not retry on a different upstream just because the first one
  // produced an HTTP error.
  assertEquals(result.type, 'upstream-error');
  assertEquals(firstCall.mock.calls.length, 1);
  assertEquals(secondCall.mock.calls.length, 0);
});

test('generate renders model-missing when no candidates are available', async () => {
  installRepo();
  queueCandidates([]);

  const result = await responsesServe.generate({
    payload: makePayload({ model: 'unknown-model' }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'upstream-error');
  if (result.type !== 'upstream-error') throw new Error('unreachable');
  assertEquals(result.status, 404);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message, 'Model unknown-model is not available on any configured upstream.');
});

test('generate renders routing-unavailable as a 400 when a forcing item names an absent upstream', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  const row: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesItems.insertMany([row]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.generate({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'upstream-error');
  if (result.type !== 'upstream-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('compact renders routing-unavailable when no candidate exposes the responses endpoint', async () => {
  const repo = installRepo();
  const id = createStoredResponsesItemId('compaction');
  await repo.responsesItems.insertMany([{
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: 'up_forcing',
    upstreamItemId: 'raw_cmp',
    itemType: 'compaction',
    origin: 'upstream',
    contentHash: null,
    encryptedContentHash: null,
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);

  queueCandidates([makeCandidate({ upstream: 'up_b' })]);

  const result = await responsesServe.compact({
    payload: makePayload({ input: [{ type: 'item_reference', id }] }),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'upstream-error');
  if (result.type !== 'upstream-error') throw new Error('unreachable');
  assertEquals(result.status, 400);
  const body = JSON.parse(new TextDecoder().decode(result.body));
  assertEquals(body.error.code, 'responses_item_routing_unavailable');
});

test('expandPreviousResponseId prepends snapshot items and strips the previous_response_id field', async () => {
  const repo = installRepo();
  // Seed a snapshot referencing one stored row; the helper resolves the id
  // through the store, then projects the snapshot's item ids as
  // `item_reference` entries ahead of the inbound input.
  const previousMessageId = createStoredResponsesItemId('message');
  await repo.responsesItems.insertMany([{
    id: previousMessageId,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id: previousMessageId, role: 'user', content: 'first turn' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  }]);
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_prev',
    apiKeyId: API_KEY_ID,
    itemIds: [previousMessageId],
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  await repo.responsesSnapshots.insert(snapshot);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const expanded = await expandPreviousResponseId(
    makePayload({
      previous_response_id: 'resp_prev',
      input: [{ type: 'message', role: 'user', content: 'second turn' }],
    }),
    store,
  );

  assertEquals(expanded.previous_response_id, undefined);
  if (!Array.isArray(expanded.input)) throw new Error('expected expanded input array');
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id: previousMessageId });
  assertEquals(expanded.input[1], { type: 'message', role: 'user', content: 'second turn' });
});

// In-memory store backed by the layered implementation but with no repo
// behind it, so an `expandPreviousResponseId` test can sit on a snapshot
// that lives nowhere else.
const memoryStore = (snapshots: readonly StoredResponsesSnapshot[], items: readonly StoredResponsesItem[]) => {
  const backing = new MemoryStatefulResponsesBacking();
  for (const item of items) void backing.insertItems([item], { durable: true });
  for (const snapshot of snapshots) void backing.insertSnapshot(snapshot);
  return new LayeredStatefulResponsesStore({
    apiKeyId: API_KEY_ID,
    reads: [backing],
    itemWrites: [{ backing, durable: true }],
    snapshotWrites: [{ backing, durable: true }],
    stageInputs: true,
    shouldStorePayload: true,
  });
};

test('expandPreviousResponseId resolves snapshots from a non-repo-backed store', async () => {
  installRepo(); // affinity lookups in the wider flow still need a repo, but here the helper only touches the store.
  const id = createStoredResponsesItemId('message');
  const item: StoredResponsesItem = {
    id,
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    itemType: 'message',
    origin: 'input',
    contentHash: null,
    encryptedContentHash: null,
    payload: { item: { type: 'message', id, role: 'user', content: 'remembered' } },
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const snapshot: StoredResponsesSnapshot = {
    id: 'resp_mem',
    apiKeyId: API_KEY_ID,
    itemIds: [id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  };
  const store = memoryStore([snapshot], [item]);

  const expanded = await expandPreviousResponseId(
    makePayload({ previous_response_id: 'resp_mem', input: [{ type: 'message', role: 'user', content: 'new turn' }] }),
    store,
  );

  if (!Array.isArray(expanded.input)) throw new Error('expected expanded input array');
  assertEquals(expanded.input.length, 2);
  assertEquals(expanded.input[0], { type: 'item_reference', id });
});

const makeMessagesProtocolFrames = async function* (events: readonly MessagesStreamEvent[]): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

const makeChatCompletionsProtocolFrames = async function* (events: readonly ChatCompletionsStreamEvent[]): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> {
  for (const event of events) yield eventFrame(event);
  yield doneFrame();
};

test('generate falls through translate-out to messages target', async () => {
  installRepo();
  const callMessages = vi.fn(async (): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: true,
    events: makeMessagesProtocolFrames([
      {
        type: 'message_start',
        message: {
          id: 'msg_translated',
          type: 'message',
          role: 'assistant',
          content: [],
          model: 'test-model',
          stop_reason: null,
          stop_sequence: null,
          usage: { input_tokens: 4, output_tokens: 0 },
        },
      },
      { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
      { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
      { type: 'content_block_stop', index: 0 },
      { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } },
      { type: 'message_stop' },
    ]),
    modelKey: 'messages-key',
  }));
  // Build a candidate with targetApi='messages' whose provider answers
  // callMessages — the translate-out branch routes through messagesAttempt
  // and calls provider.callMessages instead of provider.callResponses.
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({ callMessages });
  const candidate: ProviderCandidate = {
    provider: {
      upstream: 'up_m', providerKind: 'custom', name: 'up_m',
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_m', upstreamName: 'up_m', providerKind: 'custom',
      provider, upstreamModel, enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'messages',
  };
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  // The translate trip wraps the upstream Messages events back into Responses
  // events; draining proves the cross-protocol path composes without throwing.
  await collectEvents(result.events);
  assertEquals(callMessages.mock.calls.length, 1);
});

test('generate falls through translate-out to chat-completions target', async () => {
  installRepo();
  const callChatCompletions = vi.fn(async (): Promise<ProviderStreamResult<ChatCompletionsStreamEvent>> => ({
    ok: true,
    events: makeChatCompletionsProtocolFrames([
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { role: 'assistant' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      },
      {
        id: 'chatcmpl_translated', object: 'chat.completion.chunk', created: 0, model: 'test-model',
        choices: [], usage: { prompt_tokens: 4, completion_tokens: 2, total_tokens: 6 },
      },
    ]),
    modelKey: 'chat-completions-key',
  }));
  // Build a candidate with targetApi='chat-completions' whose provider answers
  // callChatCompletions — the translate-out branch routes through
  // chatCompletionsAttempt and calls provider.callChatCompletions instead of
  // provider.callResponses.
  const upstreamModel = stubUpstreamModel();
  const provider = stubProvider({ callChatCompletions });
  const candidate: ProviderCandidate = {
    provider: {
      upstream: 'up_c', providerKind: 'custom', name: 'up_c',
      disabledPublicModelIds: [], provider, supportsResponsesItemReference: true,
    },
    binding: {
      upstream: 'up_c', upstreamName: 'up_c', providerKind: 'custom',
      provider, upstreamModel, enabledFlags: upstreamModel.enabledFlags,
      supportsResponsesItemReference: true,
    },
    targetApi: 'chat-completions',
  };
  queueCandidates([candidate]);

  const result = await responsesServe.generate({
    payload: makePayload(),
    ctx: makeGatewayCtx(),
    store: createResponsesHttpStore(API_KEY_ID, true),
  });

  assertEquals(result.type, 'events');
  if (result.type !== 'events') throw new Error('unreachable');
  // The translate trip wraps the upstream Chat Completions events back into
  // Responses events; draining proves the cross-protocol path composes
  // without throwing.
  await collectEvents(result.events);
  assertEquals(callChatCompletions.mock.calls.length, 1);
});
