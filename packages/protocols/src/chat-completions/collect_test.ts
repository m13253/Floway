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
  ];

  const result = collectChatCompletionsStream(events);

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
  ];

  const result = collectChatCompletionsStream(events);

  assertEquals(result.choices[0].finish_reason, 'tool_calls');
  assertEquals(result.choices[0].message.tool_calls, [
    { id: 'call_a', type: 'function', function: { name: 'lookup', arguments: '{"q":"hi"}' } },
  ]);
  assertEquals(result.choices[0].message.content, null);
});
