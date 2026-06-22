import { test } from 'vitest';

import { collectMessagesStream } from './collect.ts';
import type { MessagesStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const ev = (event: MessagesStreamEvent): DumpStreamEvent => ({ frame: { type: 'event', event }, ts: 0 });

// Thin-wrapper coverage. Heavy fold logic lives in
// `reassembleMessagesEvents` and is covered by `reassemble_test.ts`.

test('happy path: terminal frame present → truncated=false, error=null, result populated', async () => {
  const outcome = await collectMessagesStream([
    ev({
      type: 'message_start',
      message: {
        id: 'msg_1', type: 'message', role: 'assistant', content: [],
        model: 'claude-test', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } }),
    ev({ type: 'content_block_stop', index: 0 }),
    ev({ type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 1 } }),
    ev({ type: 'message_stop' }),
  ]);
  assertEquals(outcome.truncated, false);
  assertEquals(outcome.error, null);
  assertEquals(outcome.warnings, []);
  assertEquals(outcome.result?.id, 'msg_1');
  assertEquals(outcome.result?.content, [{ type: 'text', text: 'hi' }]);
});

test('missing terminal → truncated=true, best-effort partial result', async () => {
  const outcome = await collectMessagesStream([
    ev({
      type: 'message_start',
      message: {
        id: 'msg_partial', type: 'message', role: 'assistant', content: [],
        model: 'claude-test', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ev({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    ev({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, null);
  assertEquals(outcome.result?.id, 'msg_partial');
});

test('mid-stream error frame → error reflects the message, truncated=true', async () => {
  const outcome = await collectMessagesStream([
    ev({
      type: 'message_start',
      message: {
        id: 'msg_err', type: 'message', role: 'assistant', content: [],
        model: 'claude-test', stop_reason: null, stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    ev({ type: 'error', error: { type: 'overloaded_error', message: 'upstream overloaded' } }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, 'upstream overloaded');
});
