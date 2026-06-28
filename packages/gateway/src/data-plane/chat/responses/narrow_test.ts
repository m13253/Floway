import { test } from 'vitest';

import { createStoredResponsesItemId } from './items/format.ts';
import { createNonResponsesSourceStore } from './items/store.ts';
import { narrowResponsesByItemAffinity } from './narrow.ts';
import { initRepo } from '../../../repo/index.ts';
import { InMemoryRepo } from '../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../repo/types.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import { directFetcher } from '@floway-dev/provider';
import { stubProvider, stubUpstreamModel, assertEquals } from '@floway-dev/test-utils';

const API_KEY_ID = 'key_routing_test';

const candidate = (upstream: string): ProviderCandidate => {
  const modelProvider = stubProvider({
    getProvidedModels: () => Promise.resolve([stubUpstreamModel()]),
  });
  return {
    provider: {
      upstream,
      providerKind: 'custom',
      name: upstream,
      disabledPublicModelIds: [],
      modelPrefix: null,
      provider: modelProvider,
      supportsResponsesItemReference: true,
    },
    model: stubUpstreamModel(),
    fetcher: directFetcher,
  };
};

const insertRows = async (rows: readonly StoredResponsesItem[]) => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  await repo.responsesItems.insertMany(rows);
  return repo;
};

const storedRow = (
  overrides: Pick<StoredResponsesItem, 'id' | 'itemType'> & Partial<StoredResponsesItem>,
): StoredResponsesItem => ({
  apiKeyId: API_KEY_ID,
  upstreamId: null,
  upstreamItemId: null,
  origin: 'upstream',
  contentHash: null,
  encryptedContentHash: null,
  payload: null,
  createdAt: 1_000,
  refreshedAt: 1_000,
  ...overrides,
});

const payload = (input: ResponsesPayload['input']): ResponsesPayload => ({
  model: 'stub-model',
  input,
});

test('payload with no stored references passes candidates through unchanged', async () => {
  await insertRows([]);
  const candidates = [candidate('up_a'), candidate('up_b')];

  const decision = await narrowResponsesByItemAffinity({
    payload: payload([{ type: 'message', role: 'user', content: 'hello' }]),
    candidates,
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  if (isChatServeFailure(decision)) throw new Error(`expected success, got failure: ${decision.kind}`);
  assertEquals(decision.length, candidates.length);
  assertEquals(decision.map(c => c.provider.upstream), ['up_a', 'up_b']);
});

test('item_reference forcing an upstream absent from candidates fails routing', async () => {
  const id = createStoredResponsesItemId('compaction');
  await insertRows([
    storedRow({ id, itemType: 'compaction', upstreamId: 'up_a', upstreamItemId: 'raw_cmp_a' }),
  ]);

  const decision = await narrowResponsesByItemAffinity({
    payload: payload([{ type: 'item_reference', id }]),
    candidates: [candidate('up_b')],
    store: createNonResponsesSourceStore(API_KEY_ID),
  });

  if (!isChatServeFailure(decision)) throw new Error('expected failure');
  assertEquals(decision.kind, 'routing-unavailable');
});
