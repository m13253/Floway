import { test } from 'vitest';

import { injectIdentityBlock } from './inject-identity-block.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { IDENTITY_BLOCK } from '../../system-blocks.ts';
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

test('appends IDENTITY_BLOCK after an existing system[0] block', async () => {
  const billing = { type: 'text' as const, text: 'x-anthropic-billing-header: cc_version=2.1.181.abc;' };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [billing],
  });

  await injectIdentityBlock(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [billing, IDENTITY_BLOCK]);
});

test('starts a fresh system array when none is present', async () => {
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
  });

  await injectIdentityBlock(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [IDENTITY_BLOCK]);
});
