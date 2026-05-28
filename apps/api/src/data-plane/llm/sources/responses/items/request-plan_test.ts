import { test } from 'vitest';

import { createStoredResponsesItemId, isStoredResponsesItemId } from './format.ts';
import {
  applyPreRoutingExpansions,
  planResponsesItemProviders,
  prepareStoredResponsesItemsForSource,
  rewriteStoredResponsesItemsForProvider,
} from './request-plan.ts';
import { initRepo } from '../../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import { assert, assertEquals, assertFalse, assertRejects } from '../../../../../test-assert.ts';
import { stubProvider, stubUpstreamModel } from '../../../../../test-helpers.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import { chatCompletionsViaResponsesItemsView, messagesViaResponsesItemsView, responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const messagesReasoningSignature = (id: string): string => `floway:responses-reasoning:v1:${btoa(id).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '')}`;

const API_KEY_ID = 'key_test';

const provider = (upstream: string, supportsResponsesItemReference = true): ModelProviderInstance & ProviderModelRecord => {
  const upstreamModel = stubUpstreamModel();
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([upstreamModel]),
  });
  return {
    upstream,
    upstreamName: upstream,
    providerKind: 'custom',
    name: upstream,
    provider: modelProvider,
    upstreamModel,
    enabledFlags: upstreamModel.enabledFlags,
    supportsResponsesItemReference,
  };
};

const insertRows = async (rows: readonly StoredResponsesItem[]) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.responsesItems.insertMany(rows);
};

const prepareResponsesItems = async (sourceItems: string | readonly ResponseInputItem[]) =>
  await prepareStoredResponsesItemsForSource(sourceItems, API_KEY_ID, responsesItemsView);

const rewriteResponsesItems = async (
  sourceItems: string | readonly ResponseInputItem[],
  prepared: Awaited<ReturnType<typeof prepareResponsesItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(sourceItems, prepared, binding, responsesItemsView);

const expandResponsesItems = async (
  sourceItems: string | readonly ResponseInputItem[],
  prepared: Awaited<ReturnType<typeof prepareResponsesItems>>,
) => await applyPreRoutingExpansions(sourceItems, prepared, responsesItemsView);

const prepareChatItems = async (messages: ChatCompletionsPayload['messages']) =>
  await prepareStoredResponsesItemsForSource(messages, API_KEY_ID, chatCompletionsViaResponsesItemsView);

const rewriteChatItems = async (
  messages: ChatCompletionsPayload['messages'],
  prepared: Awaited<ReturnType<typeof prepareChatItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(messages, prepared, binding, chatCompletionsViaResponsesItemsView);

const prepareMessagesItems = async (messages: MessagesPayload['messages']) =>
  await prepareStoredResponsesItemsForSource(messages, API_KEY_ID, messagesViaResponsesItemsView);

const rewriteMessagesItems = async (
  messages: MessagesPayload['messages'],
  prepared: Awaited<ReturnType<typeof prepareMessagesItems>>,
  binding: ProviderModelRecord,
) => await rewriteStoredResponsesItemsForProvider(messages, prepared, binding, messagesViaResponsesItemsView);

const storedRow = (
  overrides: Omit<Partial<StoredResponsesItem>, 'payload'> & Pick<StoredResponsesItem, 'id' | 'itemType'> & { payload?: unknown | null },
): StoredResponsesItem => {
  const { payload, ...rest } = overrides;
  return {
    apiKeyId: API_KEY_ID,
    upstreamId: null,
    upstreamItemId: null,
    payload: payload === undefined || payload === null
      ? null
      : typeof payload === 'object' && Object.hasOwn(payload, 'item')
        ? payload as StoredResponsesItem['payload']
        : { item: payload },
    createdAt: 1_000,
    ...rest,
  };
};

const storedMessageId = (_label: string): string => createStoredResponsesItemId('message');

const storedReasoningId = (_label: string): string => createStoredResponsesItemId('reasoning');

const storedCompactionId = (_label: string): string => createStoredResponsesItemId('compaction');

test('missing stored item_reference returns a source-renderable not found diagnostic', async () => {
  await insertRows([]);
  const id = storedMessageId('missing');

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') {
    assertEquals(plan.diagnostic.kind, 'not_found');
    assertEquals(plan.diagnostic.status, 404);
    assertEquals(plan.diagnostic.body.error.param, 'input');
  }
});

test('invalid stored item_reference ids are not looked up as stored rows', async () => {
  const id = 'msg_AAAAAA_0xVvS8c_KjD1sBkZk5qbdA';
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') assertEquals(plan.diagnostic.kind, 'not_found');
});

test('metadata-only item_reference without upstream affinity rejects instead of emitting a temporary reference', async () => {
  const id = storedMessageId('metadata-only-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: null, upstreamItemId: null, payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') assertEquals(plan.diagnostic.kind, 'not_found');
});

test('metadata-only item_reference with upstream affinity but no upstream item id rejects as not found', async () => {
  const id = storedMessageId('metadata-only-origin-reference');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: null, payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') assertEquals(plan.diagnostic.kind, 'not_found');
});

test('ordinary non-carrier strings are ignored', async () => {
  await insertRows([]);
  const prepared = await prepareResponsesItems(storedMessageId('ordinary-string'));
  const plan = planResponsesItemProviders([provider('up_a'), provider('up_b')], prepared);

  assertEquals(prepared.useSites, []);
  assertEquals([...prepared.rows.keys()], []);
  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_a', 'up_b']);
});

test('duplicate stored ids use last occurrence order in the row map', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-old' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first-new' }] },
  ]);

  assertEquals([...prepared.rows.keys()], [second, first]);
});

test('mixed portable upstreams are ordered by reverse last occurrence before remaining providers', async () => {
  const first = storedReasoningId('first');
  const second = storedReasoningId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
    storedRow({ id: second, itemType: 'reasoning', upstreamId: 'up_b', upstreamItemId: 'raw_rs_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'reasoning', id: first, summary: [{ type: 'summary_text', text: 'first' }] },
    { type: 'reasoning', id: second, summary: [{ type: 'summary_text', text: 'second' }] },
  ]);
  const plan = planResponsesItemProviders([provider('up_c'), provider('up_a'), provider('up_b')], prepared);

  assertEquals(plan.type, 'providers');
  if (plan.type === 'providers') assertEquals(plan.providers.map(item => item.upstream), ['up_b', 'up_a', 'up_c']);
});

test('conflicting compaction forcing upstreams reject the request', async () => {
  const first = storedCompactionId('first');
  const second = storedCompactionId('second');
  await insertRows([
    storedRow({ id: first, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
    storedRow({ id: second, itemType: 'compaction', upstreamId: 'up_b', upstreamItemId: 'raw_cmp_b' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'compaction', id: first },
    { type: 'compaction', id: second },
  ] as ResponseInputItem[]);
  const plan = planResponsesItemProviders([provider('up_a'), provider('up_b')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') {
    assertEquals(plan.diagnostic.kind, 'routing_unavailable');
    assertEquals(plan.diagnostic.body.error.code, 'responses_item_routing_unavailable');
  }
});

test('matching upstream rewrites to upstream_item_id', async () => {
  const id = storedMessageId('origin');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{ type: 'message', id: 'raw_msg_a', role: 'assistant', content: 'stale' }]);
});

test('non-matching reasoning is stripped from Chat reasoning_items', async () => {
  const id = storedReasoningId('reasoning');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: ChatCompletionsPayload['messages'] = [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }],
  }];
  const prepared = await prepareChatItems(messages);
  const rewritten = await rewriteChatItems(messages, prepared, provider('up_b'));

  assertEquals(rewritten, [{ role: 'assistant', content: null, reasoning_items: null }]);
});

test('row item type must match source item type before downgrade or rewrite', async () => {
  const reasoningId = storedReasoningId('wrong-type');
  await insertRows([
    storedRow({ id: reasoningId, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const prepared = await prepareResponsesItems([
    { type: 'message', id: reasoningId, role: 'assistant', content: 'visible message' },
  ] as ResponseInputItem[]);
  const plan = planResponsesItemProviders([provider('up_a')], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') assertEquals(plan.diagnostic.kind, 'routing_unavailable');
});

test('matching upstream rewrites Chat reasoning_items to upstream reasoning id', async () => {
  const id = storedReasoningId('chat-origin');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: ChatCompletionsPayload['messages'] = [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id, summary: [{ type: 'summary_text', text: 'trace' }] }],
  }];
  const prepared = await prepareChatItems(messages);
  const rewritten = await rewriteChatItems(messages, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: null,
    reasoning_items: [{ type: 'reasoning', id: 'raw_rs_a', summary: [{ type: 'summary_text', text: 'trace' }] }],
  }]);
});

test('matching upstream rewrites Messages thinking signature to upstream reasoning id', async () => {
  const id = storedReasoningId('messages-origin');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: MessagesPayload['messages'] = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature(id) },
      { type: 'text', text: 'visible' },
    ],
  }];
  const prepared = await prepareMessagesItems(messages);
  const rewritten = await rewriteMessagesItems(messages, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('raw_rs_a') },
      { type: 'text', text: 'visible' },
    ],
  }]);
});

test('non-matching reasoning is stripped from Messages thinking signature carriers', async () => {
  const id = storedReasoningId('messages-strip');
  await insertRows([
    storedRow({ id, itemType: 'reasoning', upstreamId: 'up_a', upstreamItemId: 'raw_rs_a' }),
  ]);

  const messages: MessagesPayload['messages'] = [{
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature(id) },
      { type: 'text', text: 'visible' },
    ],
  }];
  const prepared = await prepareMessagesItems(messages);
  const rewritten = await rewriteMessagesItems(messages, prepared, provider('up_b'));

  assertEquals(rewritten, [{
    role: 'assistant',
    content: [{ type: 'text', text: 'visible' }],
  }]);
});

test('non-matching portable inline items get temporary ids without leaking raw upstream ids', async () => {
  const id = storedMessageId('portable');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a' }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'portable body' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_b')) as ResponseInputItem[];
  const [item] = rewritten;

  assert(item.type === 'message');
  assert(typeof item.id === 'string');
  assert(item.id.startsWith('msg_tmp_'), item.id);
  assertFalse(isStoredResponsesItemId(item.id));
  assert(item.id !== id);
  assert(item.id !== 'raw_msg_a');
});

test('stored payload replaces stale caller content before provider id rewrite', async () => {
  const id = storedMessageId('canonical');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'canonical content' }],
      },
    }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'message', id, role: 'assistant', content: 'stale caller content' }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'canonical content' }],
  }]);
});

test('pre-routing expansion replaces stored item_reference content before provider selection', async () => {
  const id = storedMessageId('reference');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'expanded reference' }],
      },
    }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'item_reference', id }];
  const prepared = await prepareResponsesItems(sourceItems);
  const expanded = await expandResponsesItems(sourceItems, prepared);

  assertEquals(expanded, [{
    type: 'message',
    id,
    role: 'assistant',
    content: [{ type: 'output_text', text: 'expanded reference' }],
  }]);
});

test('matching upstream keeps item_reference shape and rewrites to upstream item id', async () => {
  const id = storedMessageId('origin-reference');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'item_reference', id }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a'));

  assertEquals(rewritten, [{ type: 'item_reference', id: 'raw_msg_a' }]);
});

test('matching upstream without item_reference support expands the stored item body', async () => {
  const id = storedMessageId('origin-reference-expanded');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      upstreamId: 'up_a',
      upstreamItemId: 'raw_msg_a',
      payload: {
        type: 'message',
        id,
        role: 'assistant',
        content: [{ type: 'output_text', text: 'stored content' }],
      },
    }),
  ]);

  const sourceItems: ResponseInputItem[] = [{ type: 'item_reference', id }];
  const prepared = await prepareResponsesItems(sourceItems);
  const rewritten = await rewriteResponsesItems(sourceItems, prepared, provider('up_a', false));

  assertEquals(rewritten, [{
    type: 'message',
    id: 'raw_msg_a',
    role: 'assistant',
    content: [{ type: 'output_text', text: 'stored content' }],
  }]);
});

test('metadata-only item_reference rejects when the origin upstream does not support item_reference', async () => {
  const id = storedMessageId('metadata-only-reference-unsupported');
  await insertRows([
    storedRow({ id, itemType: 'message', upstreamId: 'up_a', upstreamItemId: 'raw_msg_a', payload: null }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'item_reference', id }]);
  const plan = planResponsesItemProviders([provider('up_a', false)], prepared);

  assertEquals(plan.type, 'error');
  if (plan.type === 'error') {
    assertEquals(plan.diagnostic.kind, 'not_found');
    assertEquals(plan.diagnostic.status, 404);
    assertEquals(plan.diagnostic.body.error.message, `Item with id '${id}' not found.`);
  }
});

test('pre-routing expansion rejects corrupt falsy stored item JSON values', async () => {
  const id = storedMessageId('bad-json-value');
  await insertRows([
    storedRow({
      id,
      itemType: 'message',
      payload: false,
    }),
  ]);

  const prepared = await prepareResponsesItems([{ type: 'message', id, role: 'assistant', content: 'stale' }]);
  await assertRejects(
    () => expandResponsesItems([{ type: 'message', id, role: 'assistant', content: 'stale' }], prepared),
    Error,
    'unknown item type',
  );
});
