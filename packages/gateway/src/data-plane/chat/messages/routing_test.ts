import { test } from 'vitest';

import { planMessagesRouting } from './routing.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import { createStoredResponsesItemId } from '../responses/items/format.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import type { ChatPlanItem } from '../shared/candidates.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_messages_routing_test';

const planItem = (upstream: string): ChatPlanItem => {
  const upstreamModel = stubUpstreamModel();
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([upstreamModel]),
  });
  return {
    candidate: {
      provider: {
        upstream, providerKind: 'custom', name: upstream,
        disabledPublicModelIds: [], modelPrefix: null, provider: modelProvider,
        supportsResponsesItemReference: true,
      },
      model: upstreamModel,
      fetcher: directFetcher,
    },
    targetApi: 'messages',
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
  const candidates = [planItem('up_a'), planItem('up_b')];

  const decision = await planMessagesRouting({
    payload: payload([{ role: 'user', content: 'hello' }]),
    candidates,
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'success');
  if (decision.kind === 'success') {
    assertEquals(decision.candidates.length, candidates.length);
    assertEquals(decision.candidates.map(c => c.candidate.provider.upstream), ['up_a', 'up_b']);
  }
});

test('a reasoning signature naming an unknown stored id fails routing as item-not-found', async () => {
  installRepo();
  // A signature with `@<gateway-id>` is recognized by the view as a stored
  // reasoning reference; classifier treats a missing row as item-not-found
  // when the referenced id is one of our queryable ids.
  const reasoningId = createStoredResponsesItemId('reasoning');

  const decision = await planMessagesRouting({
    payload: payload([
      {
        role: 'assistant',
        content: [
          { type: 'thinking', thinking: 'thought', signature: `@${reasoningId}` },
        ],
      },
    ]),
    candidates: [planItem('up_a')],
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  assertEquals(decision.kind, 'failure');
  if (decision.kind === 'failure') {
    assertEquals(decision.failure.kind, 'item-not-found');
  }
});
