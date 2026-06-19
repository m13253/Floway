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

  const result = collectResponsesStream(events);

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

  const result = collectResponsesStream(events);

  assertEquals(result.status, 'completed');
  assertEquals(result.usage, { input_tokens: 5, output_tokens: 3, total_tokens: 8 });
  const message = result.output[0];
  if (message.type !== 'message') throw new Error('expected message');
  assertEquals(message.content[0], { type: 'output_text', text: 'Hi.' });
});
