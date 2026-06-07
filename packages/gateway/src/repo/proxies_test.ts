import { test } from 'vitest';

import { InMemoryRepo } from './memory.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals } from '@floway-dev/test-utils';

const upstreamFixture = (id: string, proxyFallbackList: string[]): UpstreamRecord => ({
  id,
  provider: 'custom',
  name: id,
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: { baseUrl: 'https://example.test', bearerToken: 'sk', endpoints: { chatCompletions: {} } },
  state: null,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList,
});

test('proxies repo inserts and lists ordered by sortOrder, then createdAt', async () => {
  const repo = new InMemoryRepo();
  await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', sortOrder: 1, dialTimeoutSeconds: null });
  // Sleep to guarantee a distinct createdAt for tie-breaks within the same sort_order bucket.
  await new Promise(resolve => setTimeout(resolve, 5));
  await repo.proxies.insert({ id: 'b', name: 'B', url: 'socks5://host-b:1080', sortOrder: 0, dialTimeoutSeconds: null });
  const list = await repo.proxies.list();
  assertEquals(list.map(p => p.id), ['b', 'a']);
});

test('proxies repo clears lastEgressIp and lastTestedAt when url changes', async () => {
  const repo = new InMemoryRepo();
  await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', sortOrder: 0, dialTimeoutSeconds: null });
  await repo.proxies.recordTestSuccess('a', '1.2.3.4');
  const before = await repo.proxies.getById('a');
  assertEquals(before?.lastEgressIp, '1.2.3.4');
  if (before?.lastTestedAt === null || before?.lastTestedAt === undefined) {
    throw new Error('expected lastTestedAt to be populated after recordTestSuccess');
  }

  await repo.proxies.patch('a', { url: 'socks5://host-b:1080' });
  const after = await repo.proxies.getById('a');
  assertEquals(after?.url, 'socks5://host-b:1080');
  assertEquals(after?.lastEgressIp, null);
  assertEquals(after?.lastTestedAt, null);
});

test('proxies repo keeps lastEgressIp when patching name only', async () => {
  const repo = new InMemoryRepo();
  await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host-a:1080', sortOrder: 0, dialTimeoutSeconds: null });
  await repo.proxies.recordTestSuccess('a', '1.2.3.4');

  await repo.proxies.patch('a', { name: 'A2' });
  const after = await repo.proxies.getById('a');
  assertEquals(after?.name, 'A2');
  assertEquals(after?.lastEgressIp, '1.2.3.4');
});

test('proxies repo findUpstreamsReferencing returns ids of upstreams whose fallback list contains the proxy', async () => {
  const repo = new InMemoryRepo();
  await repo.proxies.insert({ id: 'p', name: 'P', url: 'socks5://host:1080', sortOrder: 0, dialTimeoutSeconds: null });
  await repo.upstreams.save(upstreamFixture('up_1', ['p', 'direct']));
  await repo.upstreams.save(upstreamFixture('up_2', ['direct', 'p']));
  await repo.upstreams.save(upstreamFixture('up_3', ['direct']));

  const ids = (await repo.proxies.findUpstreamsReferencing('p')).toSorted();
  assertEquals(ids, ['up_1', 'up_2']);
});

test('proxies repo delete returns false when id is unknown', async () => {
  const repo = new InMemoryRepo();
  assertEquals(await repo.proxies.delete('nope'), false);
});

test('proxies repo delete returns true and removes the row', async () => {
  const repo = new InMemoryRepo();
  await repo.proxies.insert({ id: 'a', name: 'A', url: 'socks5://host:1080', sortOrder: 0, dialTimeoutSeconds: null });
  assertEquals(await repo.proxies.delete('a'), true);
  assertEquals(await repo.proxies.getById('a'), null);
});

test('proxies repo patch returns null for unknown id', async () => {
  const repo = new InMemoryRepo();
  assertEquals(await repo.proxies.patch('nope', { name: 'x' }), null);
});
