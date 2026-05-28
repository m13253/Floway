import { test } from 'vitest';

import { chatCompletionsViaResponsesItemsView, geminiViaResponsesItemsView, messagesViaResponsesItemsView, responsesItemsView } from './responses-items.ts';
import { assertEquals } from '../../test-assert.ts';
import { messagesReasoningSignature } from '../messages-and-responses/reasoning.ts';
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
          { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('rs_stored') },
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
        { type: 'thinking', thinking: 'rewritten', signature: messagesReasoningSignature('rs_next') },
        { type: 'thinking', thinking: 'ordinary', signature: 'provider-signature' },
        { type: 'text', text: 'visible' },
      ],
    },
  ]);
  assertEquals(payload.messages[0], {
    role: 'assistant',
    content: [
      { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('rs_stored') },
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
        { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('rs_stored') },
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
      { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('rs_stored') },
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
        { type: 'thinking', thinking: 'trace', signature: messagesReasoningSignature('rs_stored') },
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
          { text: 'trace', thought: true, thoughtSignature: messagesReasoningSignature('rs_not_supported') },
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

// --- mapStreamAsResponsesItems ---

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

test('responses stream view rewrites added/delta/done/completed and tracks dropped items', async () => {
  const sourceFrames = [
    eventFrame({ type: 'response.created' as const, response: responsesResultFixture({ status: 'in_progress' }) }),
    eventFrame({ type: 'response.output_item.added' as const, output_index: 0, item: { type: 'reasoning' as const, id: 'rs_keep', summary: [] } }),
    eventFrame({ type: 'response.output_text.delta' as const, output_index: 0, content_index: 0, item_id: 'rs_keep', delta: 'thought' }),
    eventFrame({ type: 'response.output_item.done' as const, output_index: 0, item: { type: 'reasoning' as const, id: 'rs_keep', summary: [{ type: 'summary_text' as const, text: 'thought' }] } }),
    eventFrame({ type: 'response.output_item.added' as const, output_index: 1, item: { type: 'reasoning' as const, id: 'rs_drop', summary: [] } }),
    eventFrame({ type: 'response.output_text.delta' as const, output_index: 1, content_index: 0, item_id: 'rs_drop', delta: 'dropped' }),
    eventFrame({ type: 'response.output_item.done' as const, output_index: 1, item: { type: 'reasoning' as const, id: 'rs_drop', summary: [{ type: 'summary_text' as const, text: 'dropped' }] } }),
    eventFrame({
      type: 'response.completed' as const, response: responsesResultFixture({
        status: 'completed',
        output: [
          { type: 'reasoning' as const, id: 'rs_keep', summary: [{ type: 'summary_text' as const, text: 'thought' }] },
          { type: 'reasoning' as const, id: 'rs_drop', summary: [{ type: 'summary_text' as const, text: 'dropped' }] },
        ],
      }),
    }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const seen: string[] = [];
  const out = await collectEventFrames(responsesItemsView.mapStreamAsResponsesItems(sourceIter(), item => {
    if (item.type !== 'reasoning') return item;
    seen.push(item.id);
    if (item.id === 'rs_drop') return null;
    return { ...item, id: `stored_${item.id}` };
  }));

  assertEquals(seen, ['rs_keep', 'rs_keep', 'rs_drop', 'rs_keep']);

  const events = out.map(frame => frame.event);
  const addedIds = events.filter(event => event.type === 'response.output_item.added').map(event => event.item.id);
  assertEquals(addedIds, ['stored_rs_keep']);
  const doneIds = events.filter(event => event.type === 'response.output_item.done').map(event => event.item.id);
  assertEquals(doneIds, ['stored_rs_keep']);
  const deltaItemIds = events
    .filter(event => event.type === 'response.output_text.delta')
    .map(event => event.item_id);
  assertEquals(deltaItemIds, ['stored_rs_keep']);
  const completed = events.find(event => event.type === 'response.completed');
  assertEquals(completed!.response.output.map(item => item.id), ['stored_rs_keep']);
});

test('messages stream view rewrites thinking signature at content_block_stop', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'partial' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: ' done' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: messagesReasoningSignature('rs_upstream') } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const seen: ResponseInputItem[] = [];
  const out = await collectEventFrames(messagesViaResponsesItemsView.mapStreamAsResponsesItems(sourceIter(), item => {
    seen.push(item);
    return item.type === 'reasoning' ? { ...item, id: 'stored_rs' } : item;
  }));

  assertEquals(seen.length, 1);
  assertEquals(seen[0], { type: 'reasoning', id: 'rs_upstream', summary: [{ type: 'summary_text', text: 'partial done' }] });

  const events = out.map(frame => frame.event);
  assertEquals(events[0].type, 'content_block_start');
  assertEquals(events[1].type, 'content_block_delta');
  assertEquals(events[2].type, 'content_block_delta');
  // signature_delta was buffered until block_stop; it is the second-to-last event now
  const lastTwo = events.slice(-2);
  assertEquals(lastTwo[0].type, 'content_block_delta');
  if (lastTwo[0].type === 'content_block_delta' && lastTwo[0].delta.type === 'signature_delta') {
    assertEquals(lastTwo[0].delta.signature, messagesReasoningSignature('stored_rs'));
  }
  assertEquals(lastTwo[1].type, 'content_block_stop');
});

test('messages stream view strips the signature carrier when mapper returns null', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'visible' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: messagesReasoningSignature('rs_drop') } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const out = await collectEventFrames(messagesViaResponsesItemsView.mapStreamAsResponsesItems(sourceIter(), () => null));
  const events = out.map(frame => frame.event);
  // start + thinking_delta + stop; the signature_delta is dropped
  assertEquals(events.length, 3);
  assertEquals(events[0].type, 'content_block_start');
  assertEquals(events[1].type, 'content_block_delta');
  assertEquals(events[2].type, 'content_block_stop');
});

test('messages stream view passes through opaque upstream signatures untouched', async () => {
  const sourceFrames = [
    eventFrame({ type: 'content_block_start' as const, index: 0, content_block: { type: 'thinking' as const, thinking: '' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'thinking_delta' as const, thinking: 'opaque thinking' } }),
    eventFrame({ type: 'content_block_delta' as const, index: 0, delta: { type: 'signature_delta' as const, signature: 'opaque-upstream-signature' } }),
    eventFrame({ type: 'content_block_stop' as const, index: 0 }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  let mapperCalls = 0;
  const out = await collectEventFrames(messagesViaResponsesItemsView.mapStreamAsResponsesItems(sourceIter(), item => {
    mapperCalls += 1;
    return item;
  }));

  assertEquals(mapperCalls, 0);
  const events = out.map(frame => frame.event);
  const signatureEvents = events.filter((event): event is Extract<typeof event, { type: 'content_block_delta' }> =>
    event.type === 'content_block_delta' && event.delta.type === 'signature_delta');
  assertEquals(signatureEvents.length, 1);
  if (signatureEvents[0].delta.type === 'signature_delta') {
    assertEquals(signatureEvents[0].delta.signature, 'opaque-upstream-signature');
  }
});

test('chat stream view rewrites reasoning_items ids and drops nulled entries', async () => {
  const baseChunk = { id: 'cc_1', object: 'chat.completion.chunk' as const, created: 0, model: 'gpt-test' };
  const sourceFrames = [
    eventFrame({
      ...baseChunk, choices: [{
        index: 0,
        delta: {
          reasoning_items: [
            { type: 'reasoning' as const, id: 'rs_keep', summary: [{ type: 'summary_text' as const, text: 'k1' }] },
            { type: 'reasoning' as const, id: 'rs_drop', summary: [{ type: 'summary_text' as const, text: 'd1' }] },
          ],
        },
        finish_reason: null,
      }],
    }),
    eventFrame({
      ...baseChunk, choices: [{
        index: 0,
        delta: {
          reasoning_items: [
            { type: 'reasoning' as const, id: 'rs_keep', summary: [{ type: 'summary_text' as const, text: 'k1 k2' }] },
          ],
        },
        finish_reason: null,
      }],
    }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  const calls: string[] = [];
  const out = await collectEventFrames(chatCompletionsViaResponsesItemsView.mapStreamAsResponsesItems(sourceIter(), item => {
    if (item.type !== 'reasoning') return item;
    calls.push(item.id);
    if (item.id === 'rs_drop') return null;
    return { ...item, id: `stored_${item.id}` };
  }));

  // mapper is called for every appearance, even repeats of the same upstream id;
  // dropped ids short-circuit before mapper is re-invoked in the same stream
  assertEquals(calls, ['rs_keep', 'rs_drop', 'rs_keep']);
  const reasoningPerChunk = out.map(frame => frame.event.choices[0].delta.reasoning_items);
  assertEquals(reasoningPerChunk, [
    [{ type: 'reasoning', id: 'stored_rs_keep', summary: [{ type: 'summary_text', text: 'k1' }] }],
    [{ type: 'reasoning', id: 'stored_rs_keep', summary: [{ type: 'summary_text', text: 'k1 k2' }] }],
  ]);
});

test('gemini stream view passes frames through without calling the mapper', async () => {
  const sourceFrames = [
    eventFrame({ candidates: [{ content: { role: 'model' as const, parts: [{ text: 'hi' }] }, finishReason: 'STOP' as const, index: 0 }] }),
  ];

  async function* sourceIter() {
    for (const frame of sourceFrames) yield frame;
  }

  let calls = 0;
  const out = await collectEventFrames(geminiViaResponsesItemsView.mapStreamAsResponsesItems(sourceIter(), item => {
    calls += 1;
    return item;
  }));

  assertEquals(calls, 0);
  assertEquals(out, sourceFrames);
});
