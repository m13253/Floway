import { test } from 'vitest';

import { collectMessagesStream } from './collect.ts';
import type { MessagesStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

const dumpEvent = (event: MessagesStreamEvent): DumpStreamEvent => ({
  event: event.type,
  data: JSON.stringify(event),
  ts: 0,
});

test('collectMessagesStream folds Anthropic streaming events into a final message', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_1',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 7, output_tokens: 0 },
      },
    }),
    dumpEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } }),
    dumpEvent({ type: 'content_block_stop', index: 0 }),
    dumpEvent({
      type: 'content_block_start',
      index: 1,
      content_block: { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: {} },
    }),
    dumpEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{"q":"hi' } }),
    dumpEvent({ type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '"}' } }),
    dumpEvent({ type: 'content_block_stop', index: 1 }),
    dumpEvent({
      type: 'message_delta',
      delta: { stop_reason: 'tool_use', stop_sequence: null },
      usage: { output_tokens: 4 },
    }),
    dumpEvent({ type: 'message_stop' }),
  ];

  const result = collectMessagesStream(events);

  assertEquals(result.id, 'msg_1');
  assertEquals(result.model, 'claude-test');
  assertEquals(result.stop_reason, 'tool_use');
  assertEquals(result.stop_sequence, null);
  assertEquals(result.usage, { input_tokens: 7, output_tokens: 4 });
  assertEquals(result.content.length, 2);
  assertEquals(result.content[0], { type: 'text', text: 'Hello, world' });
  assertEquals(result.content[1], { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'hi' } });
});

test('collectMessagesStream throws when message_start is missing', () => {
  assertThrows(
    () => collectMessagesStream([
      dumpEvent({ type: 'content_block_stop', index: 0 }),
    ]),
    Error,
    'no message_start',
  );
});
