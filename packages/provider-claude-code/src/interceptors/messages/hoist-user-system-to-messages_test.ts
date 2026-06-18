import { test } from 'vitest';

import { hoistUserSystemToMessages } from './hoist-user-system-to-messages.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ProviderStreamResult } from '@floway-dev/provider';
import { assertEquals, stubUpstreamModel } from '@floway-dev/test-utils';

const okEvents = (): Promise<ProviderStreamResult<MessagesStreamEvent>> =>
  Promise.resolve({ ok: true, events: (async function* () {})(), modelKey: 'test' });

const invocation = (payload: MessagesPayload): ClaudeCodeMessagesBoundaryCtx => ({
  payload,
  headers: {},
  model: stubUpstreamModel({ endpoints: { messages: {} } }),
  upstreamId: 'up_test',
});

test('captures a string system into a synthetic user/assistant pair and drops `system`', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'real question' }],
    system: 'You are a pirate.',
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages, [
    { role: 'user', content: '<system>\nYou are a pirate.\n</system>' },
    { role: 'assistant', content: 'I will follow the above instructions.' },
    { role: 'user', content: 'real question' },
  ]);
});

test('joins multi-block system into one synthetic turn with blank-line separators', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [
      { type: 'text', text: 'first rule' },
      { type: 'text', text: 'second rule' },
    ],
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages[0], { role: 'user', content: '<system>\nfirst rule\n\nsecond rule\n</system>' });
});

test('drops system entirely when caller did not send one and leaves messages untouched', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages.length, 1);
  assertEquals(ctx.payload.messages[0], { role: 'user', content: 'hi' });
});

test('drops system but does not inject a synthetic turn when system text is empty', async () => {
  const ctx = invocation({
    model: 'claude-test',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [{ type: 'text', text: '' }],
  });

  await hoistUserSystemToMessages(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, undefined);
  assertEquals(ctx.payload.messages.length, 1);
});
