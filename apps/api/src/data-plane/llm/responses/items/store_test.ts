import { test } from 'vitest';

import { createStoredResponsesItemId, hashResponsesItemEncryptedContent } from './format.ts';
import { prepareStoredResponsesItemsForSource } from '../../sources/responses/items/request-plan.ts';
import { createNonResponsesSourceStore, createResponsesHttpStore, createResponsesWsSession } from './store.ts';
import { initRepo } from '../../../../repo/index.ts';
import { InMemoryRepo } from '../../../../repo/memory.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ResponsesInputItem } from '@floway-dev/protocols/responses';
import { assertEquals, assertExists } from '@floway-dev/test-utils';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

const API_KEY_ID = 'key_stateful_store';

const storedRow = (overrides: Partial<StoredResponsesItem> & Pick<StoredResponsesItem, 'id' | 'itemType'>): StoredResponsesItem => ({
  apiKeyId: API_KEY_ID,
  upstreamId: null,
  upstreamItemId: null,
  origin: 'upstream',
  payload: { item: { type: overrides.itemType, id: overrides.id } },
  contentHash: null,
  encryptedContentHash: null,
  createdAt: 1_000,
  refreshedAt: 1_000,
  ...overrides,
});

test('encrypted-content lookup refreshes only the selected compatible candidate', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const encryptedContent = 'shared-encrypted-content';
  const encryptedContentHash = await hashResponsesItemEncryptedContent(encryptedContent);
  const compatible = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    encryptedContentHash,
    createdAt: 2_000,
    refreshedAt: 2_000,
  });
  const incompatible = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_b',
    upstreamItemId: 'raw_msg_b',
    encryptedContentHash,
    createdAt: 3_000,
    refreshedAt: 3_000,
  });
  await repo.responsesItems.insertMany([compatible, incompatible]);

  const input = [{ type: 'reasoning', encrypted_content: encryptedContent, summary: [] }] as unknown as ResponsesInputItem[];
  const store = createResponsesHttpStore(API_KEY_ID, undefined);
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  await prepareStoredResponsesItemsForSource(input, responsesItemsView, store);
  await store.refreshTouchedItems();

  const [readCompatible, readIncompatible] = await repo.responsesItems.lookupMany(API_KEY_ID, [compatible.id, incompatible.id]);
  assertExists(readCompatible);
  assertExists(readIncompatible);
  assertEquals(readCompatible.refreshedAt > compatible.refreshedAt, true);
  assertEquals(readIncompatible.refreshedAt, incompatible.refreshedAt);
});

test('websocket local incompatible encrypted-content candidates do not mask durable compatible rows', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const encryptedContent = 'websocket-shared-encrypted-content';
  const encryptedContentHash = await hashResponsesItemEncryptedContent(encryptedContent);
  const localIncompatible = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_local',
    upstreamItemId: 'raw_msg_local',
    encryptedContentHash,
    createdAt: 3_000,
    refreshedAt: 3_000,
  });
  const durableCompatible = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_durable',
    upstreamItemId: 'raw_rs_durable',
    encryptedContentHash,
    createdAt: 2_000,
    refreshedAt: 2_000,
  });
  await repo.responsesItems.insertMany([durableCompatible]);
  const session = createResponsesWsSession(API_KEY_ID);
  const localStore = session.createStore(false);
  localStore.stageOutputItem(localIncompatible);
  await localStore.commitOutputItems();

  const input = [{ type: 'reasoning', encrypted_content: encryptedContent, summary: [] }] as unknown as ResponsesInputItem[];
  const store = session.createStore(undefined);
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  const prepared = await prepareStoredResponsesItemsForSource(input, responsesItemsView, store);

  assertEquals(prepared.references[0].row?.id, durableCompatible.id);
});

test('snapshots with non-replayable metadata-only rows load as missing', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const missingPayload = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'input',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([missingPayload]);
  await repo.responsesSnapshots.insert({
    id: 'resp_expired',
    apiKeyId: API_KEY_ID,
    itemIds: [missingPayload.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);

  assertEquals(await store.loadSnapshot('resp_expired'), null);
});

test('snapshots with upstream-owned metadata-only rows remain replayable', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const upstreamOwned = storedRow({
    id: createStoredResponsesItemId('reasoning'),
    itemType: 'reasoning',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_rs_a',
    payload: null,
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([upstreamOwned]);
  await repo.responsesSnapshots.insert({
    id: 'resp_metadata',
    apiKeyId: API_KEY_ID,
    itemIds: [upstreamOwned.id],
    createdAt: 1_000,
    refreshedAt: 1_000,
  });

  const store = createResponsesHttpStore(API_KEY_ID, undefined);
  const snapshot = await store.loadSnapshot('resp_metadata');

  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [upstreamOwned.id]);
});

test('createNonResponsesSourceStore reads items for affinity but does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);
  const item = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    upstreamId: 'up_a',
    upstreamItemId: 'raw_msg_a',
    createdAt: 1_000,
    refreshedAt: 1_000,
  });
  await repo.responsesItems.insertMany([item]);

  const store = createNonResponsesSourceStore(API_KEY_ID);

  // Items are still readable for affinity lookups.
  const input = [{ type: 'message', id: item.id, role: 'assistant', content: [] }] as unknown as ResponsesInputItem[];
  await store.loadInputItems({ sourceItems: input, view: responsesItemsView });
  assertExists(store.getItemById(item.id));

  // commitSnapshot is a no-op when snapshotWrites is empty.
  const outputItem: StoredResponsesItem = {
    ...item,
    id: createStoredResponsesItemId('message'),
    origin: 'upstream',
    payload: { item: { type: 'message', id: 'out_1', role: 'assistant', content: [] } },
  };
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_new', 'append');

  // No snapshot was written because snapshotWrites is empty for non-Responses sources.
  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_new'), null);
});

test('createResponsesHttpStore with store=false does not write snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, false);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
  });
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_no_store', 'append');

  assertEquals(await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_no_store'), null);
});

test('createResponsesHttpStore with store=true writes snapshots', async () => {
  const repo = new InMemoryRepo();
  initRepo(repo);

  const store = createResponsesHttpStore(API_KEY_ID, true);
  const outputItem: StoredResponsesItem = storedRow({
    id: createStoredResponsesItemId('message'),
    itemType: 'message',
    origin: 'upstream',
    upstreamId: 'up_snap',
    upstreamItemId: 'raw_snap',
    payload: { item: { type: 'message', id: 'snap_1', role: 'assistant', content: [] } },
  });
  store.beginAttempt([]);
  store.stageOutputItem(outputItem);
  await store.commitOutputItems();
  await store.commitSnapshot('resp_with_store', 'append');

  const snapshot = await repo.responsesSnapshots.lookup(API_KEY_ID, 'resp_with_store');
  assertExists(snapshot);
  assertEquals(snapshot.itemIds, [outputItem.id]);
});
