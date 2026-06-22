import { test } from 'vitest';

import { collectChatCompletionsStream } from './collect.ts';
import type { ChatCompletionsStreamEvent } from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import { assertEquals } from '@floway-dev/test-utils';

const ev = (event: ChatCompletionsStreamEvent): DumpStreamEvent => ({ frame: { type: 'event', event }, ts: 0 });
const doneEvent: DumpStreamEvent = { frame: { type: 'done' }, ts: 0 };

// Thin-wrapper coverage. Heavy fold logic lives in
// `reassembleChatCompletionsEvents`, exercised by `reassemble_test.ts`.

test('happy path: [DONE] frame → truncated=false, error=null, result populated', async () => {
  const outcome = await collectChatCompletionsStream([
    ev({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: { content: 'hi' }, finish_reason: null }] }),
    ev({ id: 'c1', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] }),
    doneEvent,
  ]);
  assertEquals(outcome.truncated, false);
  assertEquals(outcome.error, null);
  assertEquals(outcome.result?.choices?.[0]?.message?.content, 'hi');
});

test('missing [DONE] → truncated=true, best-effort partial result', async () => {
  const outcome = await collectChatCompletionsStream([
    ev({ id: 'c2', object: 'chat.completion.chunk', created: 1, model: 'gpt', choices: [{ index: 0, delta: { content: 'partial' }, finish_reason: null }] }),
  ]);
  assertEquals(outcome.truncated, true);
  assertEquals(outcome.error, null);
  assertEquals(outcome.result?.choices?.[0]?.message?.content, 'partial');
});
