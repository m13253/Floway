import { test } from 'vitest';

import { injectDefaultTemplate } from './inject-default-template.ts';
import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';
import { DEFAULT_TEMPLATE_BLOCK, IDENTITY_BLOCK } from '../../system-blocks.ts';
import type { MessagesPayload, MessagesStreamEvent, MessagesTextBlock } from '@floway-dev/protocols/messages';
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

test('appends DEFAULT_TEMPLATE_BLOCK as system[2] with ephemeral cache_control intact', async () => {
  const billing: MessagesTextBlock = { type: 'text', text: 'x-anthropic-billing-header: cc_version=2.1.181.abc;' };
  const ctx = invocation({
    model: 'claude-sonnet-4-5-20250929',
    max_tokens: 16,
    messages: [{ role: 'user', content: 'hi' }],
    system: [billing, IDENTITY_BLOCK],
  });

  await injectDefaultTemplate(ctx, {}, okEvents);

  assertEquals(ctx.payload.system, [billing, IDENTITY_BLOCK, DEFAULT_TEMPLATE_BLOCK]);
  if (!Array.isArray(ctx.payload.system)) throw new Error('expected system to be an array');
  assertEquals(ctx.payload.system[2]!.cache_control, { type: 'ephemeral', ttl: '5m' });
});
