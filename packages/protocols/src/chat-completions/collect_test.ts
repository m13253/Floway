import { test } from 'vitest';

import { collectChatCompletionsStream } from './collect.ts';
import type { ChatCompletionsStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const dumpEvent = (event: ChatCompletionsStreamEvent): DumpStreamEvent => ({
  event: null,
  data: JSON.stringify(event),
  ts: 0,
});

const doneEvent: DumpStreamEvent = { event: null, data: '[DONE]', ts: 0 };

const errorEvent = (message: string): DumpStreamEvent => ({
  event: null,
  data: JSON.stringify({ error: { message, code: 'upstream_error' } }),
  ts: 0,
});

test('collectChatCompletionsStream concatenates delta content and surfaces terminal usage', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: '' }, finish_reason: null }],
    }),
    dumpEvent({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
      choices: [{ index: 0, delta: { content: 'Hello' }, finish_reason: null }],
    }),
    dumpEvent({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
      choices: [{ index: 0, delta: { content: ', world' }, finish_reason: null }],
    }),
    dumpEvent({
      id: 'chatcmpl_1', object: 'chat.completion.chunk', created: 1, model: 'gpt-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'stop' }],
      usage: { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 },
    }),
    doneEvent,
  ];

  const outcome = collectChatCompletionsStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, false);
  const result = outcome.result!;
  assertEquals(result.id, 'chatcmpl_1');
  assertEquals(result.choices.length, 1);
  assertEquals(result.choices[0].message.content, 'Hello, world');
  assertEquals(result.choices[0].finish_reason, 'stop');
  assertEquals(result.usage, { prompt_tokens: 5, completion_tokens: 2, total_tokens: 7 });
});

test('collectChatCompletionsStream assembles split tool_call name and arguments', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 2, model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, id: 'call_a', type: 'function', function: { name: 'look', arguments: '{"q":' } }] },
        finish_reason: null,
      }],
    }),
    dumpEvent({
      id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 2, model: 'gpt-test',
      choices: [{
        index: 0,
        delta: { tool_calls: [{ index: 0, function: { name: 'up', arguments: '"hi"}' } }] },
        finish_reason: null,
      }],
    }),
    dumpEvent({
      id: 'chatcmpl_2', object: 'chat.completion.chunk', created: 2, model: 'gpt-test',
      choices: [{ index: 0, delta: {}, finish_reason: 'tool_calls' }],
    }),
    doneEvent,
  ];

  const outcome = collectChatCompletionsStream(events);

  assertEquals(outcome.truncated, false);
  const result = outcome.result!;
  assertEquals(result.choices[0].finish_reason, 'tool_calls');
  assertEquals(result.choices[0].message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"hi"}' } },
  ]);
  assertEquals(result.choices[0].message.content, null);
});

test('collectChatCompletionsStream marks truncated when [DONE] and finish_reason are missing', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      id: 'chatcmpl_3', object: 'chat.completion.chunk', created: 3, model: 'gpt-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'partial' }, finish_reason: null }],
    }),
  ];

  const outcome = collectChatCompletionsStream(events);

  assertEquals(outcome.error, null);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.choices[0].message.content, 'partial');
  assertEquals(outcome.result!.choices[0].finish_reason, 'stop');
});

test('collectChatCompletionsStream detects an error-shaped chunk and keeps any partial content', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      id: 'chatcmpl_4', object: 'chat.completion.chunk', created: 4, model: 'gpt-test',
      choices: [{ index: 0, delta: { role: 'assistant', content: 'half-' }, finish_reason: null }],
    }),
    errorEvent('rate limit exceeded'),
  ];

  const outcome = collectChatCompletionsStream(events);

  assertEquals(outcome.error, 'rate limit exceeded');
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.result!.choices[0].message.content, 'half-');
});

test('collectChatCompletionsStream folds multiple choices independently', () => {
  const events: DumpStreamEvent[] = [
    dumpEvent({
      id: 'chatcmpl_5', object: 'chat.completion.chunk', created: 5, model: 'gpt-test',
      choices: [
        { index: 0, delta: { role: 'assistant', content: 'alpha' }, finish_reason: null },
        { index: 1, delta: { role: 'assistant', content: 'beta' }, finish_reason: null },
      ],
    }),
    dumpEvent({
      id: 'chatcmpl_5', object: 'chat.completion.chunk', created: 5, model: 'gpt-test',
      choices: [
        { index: 0, delta: {}, finish_reason: 'stop' },
        { index: 1, delta: {}, finish_reason: 'stop' },
      ],
    }),
    doneEvent,
  ];

  const outcome = collectChatCompletionsStream(events);

  assertEquals(outcome.truncated, false);
  assertEquals(outcome.result!.choices.length, 2);
  assertEquals(outcome.result!.choices[0].message.content, 'alpha');
  assertEquals(outcome.result!.choices[1].message.content, 'beta');
});

test('collectChatCompletionsStream returns null result when no chunks were emitted', () => {
  const outcome = collectChatCompletionsStream([]);

  assertEquals(outcome.result, null);
  assertEquals(outcome.truncated, true);
  if (!outcome.error?.includes('no chunks')) {
    throw new Error(`expected error to mention no chunks, got ${outcome.error}`);
  }
});
