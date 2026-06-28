import { test } from 'vitest';

import { narrowMessagesByItemAffinity } from './narrow.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createStoredResponsesItemId } from '../items/format.ts';
import { createNonResponsesSourceStore } from '../items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_routing_test';

const makeCtx = (): ChatGatewayCtx => ({
  apiKeyId: API_KEY_ID,
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: () => {},
  requestStartedAt: 0,
  store: createNonResponsesSourceStore(API_KEY_ID),
});

const candidate = (upstream: string): ProviderCandidate => {
  const upstreamModel = stubUpstreamModel();
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([upstreamModel]),
  });
  return {
    provider: {
      upstream, providerKind: 'custom', name: upstream,
      disabledPublicModelIds: [], modelPrefix: null, provider: modelProvider,
      supportsResponsesItemReference: true,
    },
    model: upstreamModel,
    fetcher: directFetcher,
  };
};

const installRepo = (): void => {
  const repo = new InMemoryRepo();
  initRepo(repo);
};

const payload = (messages: MessagesPayload['messages']): MessagesPayload => ({
  model: 'stub-model',
  max_tokens: 16,
  messages,
});

test('messages payload with no reasoning carriers passes candidates through unchanged', async () => {
  installRepo();
  const candidates = [candidate('up_a'), candidate('up_b')];

  const decision = await narrowMessagesByItemAffinity({
    payload: payload([{ role: 'user', content: 'hello' }]),
    candidates,
    ctx: makeCtx(),
  });

  if (isChatServeFailure(decision)) throw new Error(`expected success, got failure: ${decision.kind}`);
  assertEquals(decision.length, candidates.length);
  assertEquals(decision.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('a reasoning signature naming an unknown stored id fails routing as item-not-found', async () => {
  installRepo();
  // A signature with `@<gateway-id>` is recognized by the view as a stored
  // reasoning reference; classifier treats a missing row as item-not-found
  // when the referenced id is one of our queryable ids.
  const reasoningId = createStoredResponsesItemId('reasoning');

  const decision = await narrowMessagesByItemAffinity({
    payload: payload([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: `@${reasoningId}` },
        ],
      },
    ]),
    candidates: [candidate('up_a')],
    ctx: makeCtx(),
  });

  if (!isChatServeFailure(decision)) throw new Error('expected failure');
  assertEquals(decision.kind, 'item-not-found');
});
