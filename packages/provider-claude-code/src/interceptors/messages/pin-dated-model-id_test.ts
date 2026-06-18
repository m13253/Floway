import { test } from 'vitest';

import { pinDatedModelId } from './pin-dated-model-id.ts';
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

test('rewrites bare sonnet/opus/haiku aliases to their dated CC ids', async () => {
  for (const [alias, dated] of [
    ['claude-sonnet-4-5', 'claude-sonnet-4-5-20250929'],
    ['claude-opus-4-5', 'claude-opus-4-5-20251101'],
    ['claude-haiku-4-5', 'claude-haiku-4-5-20251001'],
  ]) {
    const ctx = invocation({ model: alias!, max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
    await pinDatedModelId(ctx, {}, okEvents);
    assertEquals(ctx.payload.model, dated);
  }
});

test('leaves an already-dated model id untouched', async () => {
  const ctx = invocation({ model: 'claude-sonnet-4-5-20250929', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
  await pinDatedModelId(ctx, {}, okEvents);
  assertEquals(ctx.payload.model, 'claude-sonnet-4-5-20250929');
});

test('passes through unknown / future model ids without rewriting', async () => {
  const ctx = invocation({ model: 'claude-sonnet-5-0-20270101', max_tokens: 1, messages: [{ role: 'user', content: 'x' }] });
  await pinDatedModelId(ctx, {}, okEvents);
  assertEquals(ctx.payload.model, 'claude-sonnet-5-0-20270101');
});
