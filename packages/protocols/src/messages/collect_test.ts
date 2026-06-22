import { test } from 'vitest';

import { collectMessagesStream } from './collect.ts';
import type { MessagesErrorEvent, MessagesStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const dumpEvent = (event: MessagesStreamEvent | MessagesErrorEvent): DumpStreamEvent => ({
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

  const outcome = collectMessagesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, false);
  const result = outcome.result!;
  assertEquals(result.id, 'msg_1');
  assertEquals(result.model, 'claude-test');
  assertEquals(result.stop_reason, 'tool_use');
  assertEquals(result.stop_sequence, null);
  assertEquals(result.usage, { input_tokens: 7, output_tokens: 4 });
  assertEquals(result.content.length, 2);
  assertEquals(result.content[0], { type: 'text', text: 'Hello, world' });
  assertEquals(result.content[1], { type: 'tool_use', id: 'toolu_1', name: 'lookup', input: { q: 'hi' } });
});

test('collectMessagesStream reports truncated when message_stop is missing and preserves partial content', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_2',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 3, output_tokens: 0 },
      },
    }),
    dumpEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }),
  ];

  const outcome = collectMessagesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.content[0], { type: 'text', text: 'partial' });
});

test('collectMessagesStream captures a mid-stream error event and keeps the partial result', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_3',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }),
    dumpEvent({ type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'before-error' } }),
    dumpEvent({ type: 'error', error: { type: 'overloaded_error', message: 'upstream overloaded' } }),
  ];

  const outcome = collectMessagesStream(events);

  assertEquals(outcome.error, 'upstream overloaded');
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.content[0], { type: 'text', text: 'before-error' });
});

test('collectMessagesStream tolerates content_block_delta before its content_block_start without throwing', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_4',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'orphan' } }),
  ];

  const outcome = collectMessagesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.content.length, 0);
});

test('collectMessagesStream returns a catastrophic outcome when message_start is missing', () => {
  const outcome = collectMessagesStream([
    dumpEvent({ type: 'content_block_stop', index: 0 }),
  ]);

  assertEquals(outcome.result, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.warnings, []);
  if (!outcome.error?.includes('message_start')) {
    throw new Error(`expected error to mention message_start, got ${outcome.error}`);
  }
});

test('collectMessagesStream surfaces an unparseable tool_use input_json buffer as a warning and leaves input empty', () => {
  // Truncated partial_json — the upstream cut the stream mid-token, so the
  // buffer accumulated `{"q":"hi` without ever receiving the closing
  // brace. The collector must NOT invent a synthetic `_partial_json` key on
  // the typed `input` shape; it should leave `input` empty and surface the
  // raw fragment via `warnings` instead.
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_partial',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 2, output_tokens: 0 },
      },
    }),
    dumpEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_partial', name: 'search', input: {} },
    }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"hi' } }),
  ];

  const outcome = collectMessagesStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.content.length, 1);
  assertEquals(outcome.result!.content[0], { type: 'tool_use', id: 'toolu_partial', name: 'search', input: {} });
  assertEquals(outcome.warnings.length, 1);
  const warning = outcome.warnings[0]!;
  if (!warning.includes('toolu_partial') || !warning.includes('{"q":"hi')) {
    throw new Error(`warning should name the block and quote the raw fragment, got: ${warning}`);
  }
});

test('collectMessagesStream returns an empty warnings array on a clean tool_use round-trip', () => {
  // Sanity: a tool_use block whose input_json_delta buffer parses cleanly
  // must not push any warning. The shape stays { warnings: [] } on the
  // happy path.
  const events: DumpStreamEvent[] = [
    dumpEvent({
      type: 'message_start',
      message: {
        id: 'msg_clean',
        type: 'message',
        role: 'assistant',
        content: [],
        model: 'claude-test',
        stop_reason: null,
        stop_sequence: null,
        usage: { input_tokens: 1, output_tokens: 0 },
      },
    }),
    dumpEvent({
      type: 'content_block_start',
      index: 0,
      content_block: { type: 'tool_use', id: 'toolu_clean', name: 'lookup', input: {} },
    }),
    dumpEvent({ type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"q":"ok"}' } }),
    dumpEvent({ type: 'content_block_stop', index: 0 }),
    dumpEvent({ type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: { output_tokens: 3 } }),
    dumpEvent({ type: 'message_stop' }),
  ];

  const outcome = collectMessagesStream(events);
  assertEquals(outcome.warnings, []);
  assertEquals(outcome.result!.content[0], { type: 'tool_use', id: 'toolu_clean', name: 'lookup', input: { q: 'ok' } });
});
