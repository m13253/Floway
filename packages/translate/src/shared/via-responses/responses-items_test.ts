import { test } from 'vitest';

import { chatCompletionsViaResponsesItemsView, geminiViaResponsesItemsView, messagesViaResponsesItemsView, responsesItemsView, type ResponsesItemFinalizedHandler, type ResponsesItemIdMapper } from './responses-items.ts';
import { assertEquals } from '../../test-assert.ts';
import { packReasoningSignature } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type EventFrame } from '@floway-dev/protocols/common';
import type { GeminiGenerateContentRequest } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { ResponseInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

test('mapAsResponsesItems maps Responses input items through the callback', async () => {
  const payload: ResponsesPayload = {
    model: 'gpt-test',
    input: [
      { type: 'item_reference', id: 'msg_stored' },
      { type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] },
      { type: 'function_call', call_id: 'call_stored', name: 'lookup', arguments: '{}', status: 'completed' },
    ],
  };

  const mapped = await responsesItemsView.mapAsResponsesItems(payload.input, item => {
    if (item.type === 'item_reference') return { type: 'message', role: 'user', content: 'expanded' };
    if (item.type === 'reasoning') return { ...item, id: 'rs_next' };
    if (item.type === 'function_call') return null;
    return item;
  });

  assertEquals(mapped, [
    { type: 'message', role: 'user', content: 'expanded' },
    { type: 'reasoning', id: 'rs_next', summary: [{ type: 'summary_text', text: 'trace' }] },
  ]);
  assertEquals(payload.input[0], { type: 'item_reference', id: 'msg_stored' });
});

test('mapAsResponsesItems maps only Messages thinking blocks with gateway reasoning signatures', async () => {
  const payload: MessagesPayload = {
    model: 'claude-test',
    max_tokens: 256,
    messages: [
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
          { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
          { type: 'text', text: 'visible' },
        ],
      },
    ],
  };

  const mapped = await messagesViaResponsesItemsView.mapAsResponsesItems(payload.messages, item => {
    if (item.type !== 'reasoning') return item;
    return { ...item, id: 'rs_next', summary: [{ type: 'summary_text', text: 'rewritten' }] };
  });

  assertEquals(mapped, [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'rewritten', signature: packReasoningSignature('rs_next', '') },
        { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
        { type: 'text', text: 'visible' },
      ],
    },
  ]);
  assertEquals(payload.messages[0], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
      { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
      { type: 'text', text: 'visible' },
    ],
  });
});

test('visitAsResponsesItems scans Messages carriers without rebuilding source messages', async () => {
  const messages: MessagesPayload['messages'] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
        { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
        { type: 'text', text: 'visible' },
      ],
    },
  ];
  const visited: ResponseInputItem[] = [];

  const result = await messagesViaResponsesItemsView.visitAsResponsesItems(messages, item => {
    visited.push(item);
  });

  assertEquals(result, undefined);
  assertEquals(visited, [
    { type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] },
  ]);
  assertEquals(messages[0], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
      { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
      { type: 'text', text: 'visible' },
    ],
  });
});

test('mapAsResponsesItems can drop carried Messages reasoning without touching other content', async () => {
  const messages: MessagesPayload['messages'] = [
    {
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'trace', signature: packReasoningSignature('rs_stored', '') },
        { type: 'text', text: 'visible' },
      ],
    },
  ];

  const mapped = await messagesViaResponsesItemsView.mapAsResponsesItems(messages, item => (item.type === 'reasoning' ? null : item));

  assertEquals(mapped, [
    {
      role: 'assistant',
      content: [{ type: 'text', text: 'visible' }],
    },
  ]);
});

test('mapAsResponsesItems maps Chat reasoning_items and leaves non-carriers unchanged', async () => {
  const payload: ChatCompletionsPayload = {
    model: 'gpt-test',
    messages: [
      { role: 'system', content: 'keep system' },
      {
        role: 'assistant',
        content: null,
        reasoning_items: [{ type: 'reasoning', id: 'rs_stored', summary: [{ type: 'summary_text', text: 'trace' }] }],
        tool_calls: [{ id: 'call_stored', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
      },
      { role: 'tool', tool_call_id: 'call_stored', content: '42' },
    ],
  };

  const mapped = await chatCompletionsViaResponsesItemsView.mapAsResponsesItems(payload.messages, item => {
    if (item.type !== 'reasoning') return item;
    return { ...item, id: 'rs_next', summary: [{ type: 'summary_text', text: 'next' }] };
  });

  assertEquals(mapped, [
    { role: 'system', content: 'keep system' },
    {
      role: 'assistant',
      content: null,
      reasoning_items: [
        { type: 'reasoning', id: 'rs_next', summary: [{ type: 'summary_text', text: 'next' }] },
      ],
      tool_calls: [{ id: 'call_stored', type: 'function', function: { name: 'lookup', arguments: '{}' } }],
    },
    { role: 'tool', tool_call_id: 'call_stored', content: '42' },
  ]);
});

test('mapAsResponsesItems does not treat Gemini thought signatures as Responses carriers', async () => {
  const payload: GeminiGenerateContentRequest = {
    contents: [
      {
        role: 'model',
        parts: [
          { text: 'trace', thought: true, thoughtSignature: packReasoningSignature('rs_not_supported', '') },
          { functionCall: { id: 'call_stored', name: 'lookup', args: { q: 'x' } } },
        ],
      },
    ],
  };

  let calls = 0;
  const mapped = await geminiViaResponsesItemsView.mapAsResponsesItems(payload.contents!, item => {
    calls += 1;
    return item;
  });

  assertEquals(calls, 0);
  assertEquals(mapped, payload.contents);
  assertEquals(mapped === payload.contents, false);
});

// --- streamMapIdAsResponsesItems ---

const collectEventFrames = async <T>(iter: AsyncIterable<{ type: string } | EventFrame<T>>): Promise<EventFrame<T>[]> => {
  const out: EventFrame<T>[] = [];
  for await (const frame of iter) {
    if (frame.type === 'event') out.push(frame as EventFrame<T>);
  }
  return out;
};

const responsesResultFixture = (overrides: { status: 'in_progress' | 'completed' | 'incomplete' | 'failed'; output?: unknown[] }) => ({
  id: 'resp_1',
  object: 'response' as const,
  model: 'gpt-test',
  status: overrides.status,
  output: (overrides.output ?? []) as never,
  output_text: '',
  error: null,
  incomplete_details: null,
});

const recordingIdMapper = (calls: Array<[string, string]>): ResponsesItemIdMapper => (upstreamId, itemType) => {
  calls.push([upstreamId, itemType]);
  return `stored_${upstreamId}`;
};

const recordingOnFinalized = (calls: Array<{ id: string; type: string; newId: string }>): ResponsesItemFinalizedHandler => (originalItem, newId) => {
  calls.push({ id: (originalItem as { id: string }).id, type: originalItem.type, newId });
};

test('responses stream view rewrites added/delta/done/completed and finalizes once per upstream id', async () => {
  const sourceFrames = [
    eventFrame({ type: 'response.created' as const, response: responsesResultFixture({ status: 'in_progress' }) }),
    eventFrame({ type: 'response.output_item.added' as const, output_index: 0, item: { type: 'reasoning' as const, id: 'rs_alpha', summary: [] } }),
    eventFrame({ type: 'response.output_text.delta' as const, output_index: 0, content_index: 0, item_id: 'rs_alpha', delta: 'thought' }),
    eventFrame({ type: 'response.output_item.done' as const, output_index: 0, item: { type: 'reasoning' as const, id: 'rs_alpha', summary: [{ type: 'summary_text' as const, text: 'thought' }] } }),
    eventFrame({
      type: 'response.completed' as const, response: responsesResultFixture({
        status: 'completed',
        output: [
          { type: 'reasoning' as const, id: 'rs_alpha', summary: [{ type: 'summary_text' as const, text: 'thought' }] },
          { type: 'reasoning' as const, id: 'rs_beta', summary: [{ type: 'summary_text' as const, text: 'second' }] },
        ],
      }),
    }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(responsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  // idMapper sees alpha at added/delta/done plus alpha and beta at completed.
  assertEquals(idCalls.map(([id]) => id), ['rs_alpha', 'rs_alpha', 'rs_alpha', 'rs_alpha', 'rs_beta']);
  // onItemFinalized fires exactly once per upstream id: alpha at done, beta at completed.
  assertEquals(finalCalls, [
    { id: 'rs_alpha', type: 'reasoning', newId: 'stored_rs_alpha' },
    { id: 'rs_beta', type: 'reasoning', newId: 'stored_rs_beta' },
  ]);

  const events = out.map(frame => frame.event);
  const addedIds = events.filter(event => event.type === 'response.output_item.added').map(event => event.item.id);
  assertEquals(addedIds, ['stored_rs_alpha']);
  const doneIds = events.filter(event => event.type === 'response.output_item.done').map(event => event.item.id);
  assertEquals(doneIds, ['stored_rs_alpha']);
  const deltaItemIds = events.filter(event => event.type === 'response.output_text.delta').map(event => event.item_id);
  assertEquals(deltaItemIds, ['stored_rs_alpha']);
  const completed = events.find(event => event.type === 'response.completed');
  assertEquals(completed!.response.output.map(item => item.id), ['stored_rs_alpha', 'stored_rs_beta']);
});

test('messages stream view rewrites a redacted_thinking carrier and finalizes once', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'redacted_thinking' as const, data: packReasoningSignature('rs_upstream', 'opaque') } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(messagesViaResponsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  assertEquals(idCalls, [['rs_upstream', 'reasoning']]);
  assertEquals(finalCalls, [{ id: 'rs_upstream', type: 'reasoning', newId: 'stored_rs_upstream' }]);

  const start = out[0].event;
  assertEquals(start.type, 'content_block_start');
  if (start.type === 'content_block_start' && start.content_block.type === 'redacted_thinking') {
    assertEquals(start.content_block.data, packReasoningSignature('stored_rs_upstream', 'opaque'));
  }
});

test('messages stream view buffers signature_delta until stop and finalizes once', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'partial' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: ' done' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: packReasoningSignature('rs_upstream', '') } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(messagesViaResponsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  assertEquals(idCalls, [['rs_upstream', 'reasoning']]);
  assertEquals(finalCalls, [{ id: 'rs_upstream', type: 'reasoning', newId: 'stored_rs_upstream' }]);

  const events = out.map(frame => frame.event);
  // start + 2 thinking deltas, then rewritten signature_delta, then stop
  assertEquals(events[0].type, 'content_block_start');
  assertEquals(events[1].type, 'content_block_delta');
  assertEquals(events[2].type, 'content_block_delta');
  const lastTwo = events.slice(-2);
  assertEquals(lastTwo[0].type, 'content_block_delta');
  if (lastTwo[0].type === 'content_block_delta' && lastTwo[0].delta.type === 'signature_delta') {
    assertEquals(lastTwo[0].delta.signature, packReasoningSignature('stored_rs_upstream', ''));
  }
  assertEquals(lastTwo[1].type, 'content_block_stop');
});

test('messages stream view preserves opaque upstream signatures and skips finalize', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'opaque thinking' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: 'opaque-upstream-signature' } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(messagesViaResponsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  assertEquals(idCalls, []);
  assertEquals(finalCalls, []);
  const events = out.map(frame => frame.event);
  const signatureEvents = events.filter((event): event is Extract<typeof event, { type: 'content_block_delta' }> =>
    event.type === 'content_block_delta' && event.delta.type === 'signature_delta');
  assertEquals(signatureEvents.length, 1);
  if (signatureEvents[0].delta.type === 'signature_delta') {
    assertEquals(signatureEvents[0].delta.signature, 'opaque-upstream-signature');
  }
});

test('messages stream view throws on thinking_delta arriving without an open block', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'orphan' } }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  let thrown: unknown;
  try {
    for await (const _ of messagesViaResponsesItemsView.streamMapIdAsResponsesItems(
      sourceIter(),
      () => 'stored_x',
    )) { /* drain */ }
  } catch (e) { thrown = e; }
  assertEquals(thrown instanceof Error, true);
});

test('chat stream view rewrites reasoning_items ids and finalizes once per upstream id', async () => {
  const baseChunk = { id: 'cc_1', object: 'chat.completion.chunk' as const, created: 0, model: 'gpt-test' };
  const sourceFrames = [
    eventFrame({
      ...baseChunk, choices: [{
        index: 0,
        delta: {
          reasoning_items: [
            { type: 'reasoning' as const, id: 'rs_alpha', summary: [{ type: 'summary_text' as const, text: 'full alpha' }] },
            { type: 'reasoning' as const, id: 'rs_beta', summary: [{ type: 'summary_text' as const, text: 'full beta' }] },
          ],
        },
        finish_reason: null,
      }],
    }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(chatCompletionsViaResponsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  assertEquals(idCalls, [['rs_alpha', 'reasoning'], ['rs_beta', 'reasoning']]);
  assertEquals(finalCalls, [
    { id: 'rs_alpha', type: 'reasoning', newId: 'stored_rs_alpha' },
    { id: 'rs_beta', type: 'reasoning', newId: 'stored_rs_beta' },
  ]);
  assertEquals(out[0].event.choices[0].delta.reasoning_items, [
    { type: 'reasoning', id: 'stored_rs_alpha', summary: [{ type: 'summary_text', text: 'full alpha' }] },
    { type: 'reasoning', id: 'stored_rs_beta', summary: [{ type: 'summary_text', text: 'full beta' }] },
  ]);
});

test('gemini stream view passes frames through without calling either callback', async () => {
  const sourceFrames = [
    eventFrame({ candidates: [{ content: { role: 'model' as const, parts: [{ text: 'hi' }] }, finishReason: 'STOP' as const, index: 0 }] }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const idCalls: Array<[string, string]> = [];
  const finalCalls: Array<{ id: string; type: string; newId: string }> = [];
  const out = await collectEventFrames(geminiViaResponsesItemsView.streamMapIdAsResponsesItems(
    sourceIter(),
    recordingIdMapper(idCalls),
    recordingOnFinalized(finalCalls),
  ));

  assertEquals(idCalls, []);
  assertEquals(finalCalls, []);
  assertEquals(out, sourceFrames);
});
