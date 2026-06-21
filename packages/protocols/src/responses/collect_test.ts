import { test } from 'vitest';

import { collectResponsesStream } from './collect.ts';
import type { ResponsesResult, ResponsesStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const dumpEvent = (event: ResponsesStreamEvent): DumpStreamEvent => ({
  event: event.type,
  data: JSON.stringify(event),
  ts: 0,
});

const baseResponse: ResponsesResult = {
  id: 'resp_1',
  object: 'response',
  model: 'gpt-test',
  output: [],
  status: 'in_progress',
  error: null,
  incomplete_details: null,
};

test('collectResponsesStream folds output_item.added and output_text.delta over a streaming response', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({ type: 'response.in_progress', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    }),
    dumpEvent({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'Hello',
    }),
    dumpEvent({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: ', world',
    }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  const result = outcome.result!;
  assertEquals(result.id, 'resp_1');
  assertEquals(result.output.length, 1);
  const message = result.output[0];
  if (message.type !== 'message') throw new Error('expected message');
  assertEquals(message.content[0], { type: 'output_text', text: 'Hello, world' });
});

test('collectResponsesStream adopts the terminal response.completed payload verbatim', () => {
  const finalResponse: ResponsesResult = {
    ...baseResponse,
    status: 'completed',
    output: [
      { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: 'Hi.' }] },
    ],
    usage: { input_tokens: 5, output_tokens: 3, total_tokens: 8 },
  };

  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_1', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    }),
    dumpEvent({
      type: 'response.output_text.delta',
      item_id: 'msg_1',
      output_index: 0,
      content_index: 0,
      delta: 'Hi.',
    }),
    dumpEvent({ type: 'response.completed', response: finalResponse }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, false);
  const result = outcome.result!;
  assertEquals(result.status, 'completed');
  assertEquals(result.usage, { input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  const message = result.output[0];
  if (message.type !== 'message') throw new Error('expected message');
  assertEquals(message.content[0], { type: 'output_text', text: 'Hi.' });
});

test('collectResponsesStream truncated stream preserves text accumulated only via deltas', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_t', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    }),
    dumpEvent({ type: 'response.output_text.delta', item_id: 'msg_t', output_index: 0, content_index: 0, delta: 'partial-' }),
    dumpEvent({ type: 'response.output_text.delta', item_id: 'msg_t', output_index: 0, content_index: 0, delta: 'text' }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  const message = outcome.result!.output[0];
  if (message.type !== 'message') throw new Error('expected message');
  assertEquals(message.content[0], { type: 'output_text', text: 'partial-text' });
});

test('collectResponsesStream concatenates split function_call_arguments deltas (delta-only fold, no terminal)', () => {
  // No terminal frame here on purpose: when terminal is present, the collector
  // adopts its payload verbatim and the delta-fold branch is unreachable. To
  // prove the delta path actually concatenates, the assertion must depend on
  // it being the only source of `arguments`.
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_1', call_id: 'call_a', name: 'lookup', arguments: '', status: 'in_progress' },
    }),
    dumpEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '{"q":' }),
    dumpEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_1', output_index: 0, delta: '"hi"}' }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  const item = outcome.result!.output[0];
  if (item.type !== 'function_call') throw new Error('expected function_call');
  assertEquals(item.arguments, '{"q":"hi"}');
});

test('collectResponsesStream preserves arguments fold when stream truncates before terminal', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'function_call', id: 'fc_2', call_id: 'call_b', name: 'lookup', arguments: '', status: 'in_progress' },
    }),
    dumpEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 0, delta: '{"a":1' }),
    dumpEvent({ type: 'response.function_call_arguments.delta', item_id: 'fc_2', output_index: 0, delta: ',"b":2' }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.truncated, true);
  const item = outcome.result!.output[0];
  if (item.type !== 'function_call') throw new Error('expected function_call');
  assertEquals(item.arguments, '{"a":1,"b":2');
});

test('collectResponsesStream accumulates reasoning_summary_text deltas', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'reasoning', id: 'rs_1', summary: [] },
    }),
    dumpEvent({
      type: 'response.reasoning_summary_part.added',
      item_id: 'rs_1', output_index: 0, summary_index: 0,
      part: { type: 'summary_text', text: '' },
    }),
    dumpEvent({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'think ' }),
    dumpEvent({ type: 'response.reasoning_summary_text.delta', item_id: 'rs_1', output_index: 0, summary_index: 0, delta: 'twice' }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.truncated, true);
  const item = outcome.result!.output[0];
  if (item.type !== 'reasoning') throw new Error('expected reasoning');
  assertEquals(item.summary[0], { type: 'summary_text', text: 'think twice' });
});

test('collectResponsesStream marks the outcome truncated when terminal is response.incomplete', () => {
  // Terminal frames take precedence — the collector adopts response.incomplete
  // verbatim regardless of mid-stream deltas. What this test actually proves
  // is the contract that holds: terminal status of `incomplete` or `failed`
  // surfaces `truncated: true` so callers know the result is partial.
  const incompleteResponse: ResponsesResult = {
    ...baseResponse,
    status: 'incomplete',
    incomplete_details: { reason: 'max_output_tokens' },
    output: [
      { type: 'message', id: 'msg_i', role: 'assistant', content: [{ type: 'output_text', text: 'cut off' }] },
    ],
  };

  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_i', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    }),
    dumpEvent({ type: 'response.output_text.delta', item_id: 'msg_i', output_index: 0, content_index: 0, delta: 'cut off' }),
    dumpEvent({ type: 'response.incomplete', response: incompleteResponse }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.status, 'incomplete');
});

test('collectResponsesStream surfaces a mid-stream error frame and keeps the partial result', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({ type: 'response.created', response: baseResponse }),
    dumpEvent({
      type: 'response.output_item.added',
      output_index: 0,
      item: { type: 'message', id: 'msg_e', role: 'assistant', content: [{ type: 'output_text', text: '' }] },
    }),
    dumpEvent({ type: 'response.output_text.delta', item_id: 'msg_e', output_index: 0, content_index: 0, delta: 'before-err' }),
    dumpEvent({ type: 'error', message: 'upstream gave up' }),
  ];

  const outcome = collectResponsesStream(events);

  assertEquals(outcome.error, 'upstream gave up');
  assertEquals(outcome.truncated, true);
  const message = outcome.result!.output[0];
  if (message.type !== 'message') throw new Error('expected message');
  assertEquals(message.content[0], { type: 'output_text', text: 'before-err' });
});

test('collectResponsesStream returns a catastrophic outcome when no created or terminal frame ever arrived', () => {
  const outcome = collectResponsesStream([]);

  assertEquals(outcome.result, null);
  assertEquals(outcome.truncated, true);
  if (!outcome.error?.includes('no response.created')) {
    throw new Error(`expected error to mention no response.created, got ${outcome.error}`);
  }
});
