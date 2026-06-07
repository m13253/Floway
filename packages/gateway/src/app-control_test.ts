import { test } from 'vitest';

import { DEFAULT_SEARCH_CONFIG } from './data-plane/tools/web-search/search-config.ts';
import { requestApp, setupAppTest } from './test-helpers.ts';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

test('session token grants control-plane access but is rejected on data-plane', async () => {
  const { adminSession } = await setupAppTest();

  const exportResponse = await requestApp('/api/export', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(exportResponse.status, 200);

  const modelsResponse = await requestApp('/v1/models', {
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(modelsResponse.status, 401);
});

test('ADMIN_KEY presented as x-api-key on data plane is rejected', async () => {
  const { adminKey } = await setupAppTest();
  const response = await requestApp('/v1/models', { headers: { 'x-api-key': adminKey } });
  assertEquals(response.status, 401);
});

test('uncaught internal errors include debug details in the HTTP body', async () => {
  const { repo, apiKey } = await setupAppTest();
  repo.apiKeys.findByRawKey = () => Promise.reject(new Error('api key lookup failed'));

  const response = await requestApp('/api/keys', {
    method: 'GET',
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 500);
  const body = await response.json();
  assertEquals(body.error.type, 'internal_error');
  assertEquals(body.error.name, 'Error');
  assertEquals(body.error.message, 'api key lookup failed');
  assertEquals(body.error.method, 'GET');
  assertEquals(body.error.path, '/api/keys');
  assertExists(body.error.stack);
});

test('API key users only see their own key in /api/keys', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
  });

  const response = await requestApp('/api/keys', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 1);
  assertEquals(body[0].id, apiKey.id);
  assertEquals(body[0].key, apiKey.key);
});

test('API key users cannot call admin-only key mutation routes', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp(`/api/keys/${apiKey.id}/rotate`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: 'Admin privileges required' });
});

test('API key users cannot mutate /api/search-config routes', async () => {
  const { apiKey } = await setupAppTest();

  const response = await requestApp('/api/search-config', {
    method: 'PUT',
    headers: {
      'content-type': 'application/json',
      'x-api-key': apiKey.key,
    },
    body: JSON.stringify(DEFAULT_SEARCH_CONFIG),
  });

  assertEquals(response.status, 403);
  assertEquals(await response.json(), { error: 'Admin privileges required' });
});

test('/api/token-usage is visible to any authenticated user and includes all keys', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-03-15T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
  });
  await repo.usage.set({
    keyId: apiKey.id,
    model: 'claude-sonnet-4',
    upstream: null,
    modelKey: 'claude-sonnet-4',
    hour: '2026-03-15T10',
    requests: 2,
    tokens: { input: 10, output: 5, input_cache_read: 4, input_cache_write: 1 },
    cost: null,
  });
  await repo.usage.set({
    keyId: 'key_other',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-15T11',
    requests: 1,
    tokens: { input: 20, output: 8, input_cache_read: 6, input_cache_write: 2 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-15T00&end=2026-03-16T00', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 2);
  assertEquals(body[0].keyName, 'Primary key');
  assertEquals(body[1].keyName, 'Other key');
  assertEquals(body[0].keyCreatedAt, apiKey.createdAt);
  assertEquals(body[1].keyCreatedAt, '2026-03-15T00:00:00.000Z');
  const ownRecord = body.find((record: { keyId: string }) => record.keyId === apiKey.id);
  const otherRecord = body.find((record: { keyId: string }) => record.keyId === 'key_other');
  assertExists(ownRecord);
  assertExists(otherRecord);
  assertEquals(ownRecord.tokens.input_cache_read, 4);
  assertEquals(ownRecord.tokens.input_cache_write, 1);
  assertEquals(otherRecord.tokens.input_cache_read, 6);
  assertEquals(otherRecord.tokens.input_cache_write, 2);
});

test('/api/token-usage can include all key metadata for stable dashboard color slots', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.apiKeys.save({
    id: 'key_other',
    userId: 1,
    name: 'Other key',
    key: 'raw_other_key',
    createdAt: '2026-03-16T00:00:00.000Z',
    upstreamIds: null,
    deletedAt: null,
  });
  await repo.usage.set({
    keyId: 'key_other',
    model: 'gpt-5',
    upstream: null,
    modelKey: 'gpt-5',
    hour: '2026-03-16T10',
    requests: 1,
    tokens: { input: 20, output: 8 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-16T00&end=2026-03-17T00&include_key_metadata=1', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.records.length, 1);
  assertEquals(body.keyColorOrder, [
    '46360b74-2457-4a38-a116-7afdb2894632',
    '4969165b-3412-436c-87d9-3fd4770164b5',
    '541128df-ee71-4fc1-9cc7-6855ca1e7fcc',
    'e694733c-370e-4b9a-9331-57eefd12a8cc',
    '5a4481c9-0230-481c-bd17-49fc2bda6f02',
    'future-1',
    '3f2fe5b9-2991-4bb8-bc04-2852f58150ca',
    'future-3',
    'future-2',
    'future-4',
  ]);
  assertEquals(body.keys, [
    {
      id: apiKey.id,
      name: apiKey.name,
      createdAt: apiKey.createdAt,
    },
    {
      id: 'key_other',
      name: 'Other key',
      createdAt: '2026-03-16T00:00:00.000Z',
    },
  ]);
});

test('/api/token-usage merges Claude variants into backend base model records', async () => {
  const { repo, apiKey } = await setupAppTest();
  const shared = {
    keyId: apiKey.id,
    hour: '2026-03-17T10',
    upstream: 'copilot:1',
    requests: 1,
    tokens: { input: 10, output: 5, input_cache_read: 2, input_cache_write: 1 },
  };

  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-xhigh',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'claude-opus-4-7',
    modelKey: 'claude-opus-4.7-1m-internal',
    cost: null,
  });
  await repo.usage.set({
    ...shared,
    model: 'gpt-5.3-codex',
    modelKey: 'gpt-5.3-codex',
    tokens: { input: 3, output: 4 },
    cost: null,
  });

  const response = await requestApp('/api/token-usage?start=2026-03-17T00&end=2026-03-18T00', { headers: { 'x-api-key': apiKey.key } });

  assertEquals(response.status, 200);
  const body = await response.json();
  assertEquals(body.length, 2);
  const opus = body.find((record: { model: string }) => record.model === 'claude-opus-4-7');
  const gpt = body.find((record: { model: string }) => record.model === 'gpt-5.3-codex');
  assertExists(opus);
  assertExists(gpt);
  assertEquals(opus.requests, 3);
  assertEquals(opus.tokens.input, 30);
  assertEquals(opus.tokens.output, 15);
  assertEquals(opus.tokens.input_cache_read, 6);
  assertEquals(opus.tokens.input_cache_write, 3);
});
