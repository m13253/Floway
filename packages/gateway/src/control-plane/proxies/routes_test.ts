import { beforeEach, test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { initSocketDial, type SocketDial } from '@floway-dev/platform';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Stub SocketDial so the test endpoint hits a deterministic error path
// (`runProxiedRequest` calls connect() and we surface its rejection as the
// response's `error` field). The proxy library has no other path to a real
// socket, so this fully isolates the handler from the network. The stub is
// re-installed before each test rather than reset between tests because
// `initSocketDial` overrides the module-level singleton in place — every
// test that needs the stub gets a fresh one, and any subsequent suite that
// installs its own impl will replace ours the same way.
const stubFailingSocketDial = (message: string): SocketDial => ({
  connect: async () => {
    throw new Error(message);
  },
});

beforeEach(() => {
  initSocketDial(stubFailingSocketDial('stub: dial refused'));
});

const SOCKS_URL = 'socks5://user:pass@198.51.100.10:1080';
const HTTP_URL = 'http://198.51.100.20:3128';

const authed = (adminKey: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-api-key': adminKey,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

const patchAuthed = (adminKey: string, body: unknown): RequestInit => ({
  method: 'PATCH',
  headers: {
    'content-type': 'application/json',
    'x-api-key': adminKey,
  },
  body: JSON.stringify(body),
});

const deleteAuthed = (adminKey: string): RequestInit => ({
  method: 'DELETE',
  headers: { 'x-api-key': adminKey },
});

interface ProxyJson {
  id: string;
  name: string;
  url: string;
  sort_order: number;
  created_at: string;
  updated_at: string;
  last_egress_ip: string | null;
  last_tested_at: number | null;
}

test('GET /api/proxies returns rows ordered by sort_order', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_b', name: 'Second', url: SOCKS_URL, sortOrder: 2 });
  await repo.proxies.insert({ id: 'p_a', name: 'First', url: HTTP_URL, sortOrder: 1 });

  const resp = await requestApp('/api/proxies', authed(adminKey));
  assertEquals(resp.status, 200);
  const list = (await resp.json()) as ProxyJson[];
  assertEquals(list.map(p => p.id), ['p_a', 'p_b']);
  assertEquals(list[0].name, 'First');
  assertEquals(list[0].url, HTTP_URL);
  assertEquals(list[0].last_egress_ip, null);
  assertEquals(list[0].last_tested_at, null);
});

test('POST /api/proxies creates a row and assigns the next sort_order', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_first', name: 'First', url: HTTP_URL, sortOrder: 7 });

  const resp = await requestApp('/api/proxies', authed(adminKey, { name: 'New', url: SOCKS_URL }));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as ProxyJson;
  assertEquals(created.name, 'New');
  assertEquals(created.url, SOCKS_URL);
  assertEquals(created.sort_order, 8);

  const stored = await repo.proxies.getById(created.id);
  assertExists(stored);
  assertEquals(stored.url, SOCKS_URL);
});

test('POST /api/proxies rejects an unparseable URL with 400', async () => {
  const { adminKey } = await setupAppTest();

  const resp = await requestApp('/api/proxies', authed(adminKey, { name: 'Bad', url: 'gibberish' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error?: string };
  assertEquals(typeof body.error, 'string');
  assertEquals(body.error?.startsWith('Invalid proxy URI:'), true);
});

test('PATCH /api/proxies/:id partially updates a proxy row', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, sortOrder: 0 });

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminKey, { name: 'Renamed' }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as ProxyJson;
  assertEquals(updated.name, 'Renamed');
  assertEquals(updated.url, HTTP_URL);
});

test('PATCH /api/proxies/:id with a new url clears the cached egress ip', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p1', name: 'Old', url: HTTP_URL, sortOrder: 0 });
  await repo.proxies.recordTestSuccess('p1', '203.0.113.1');

  const before = await repo.proxies.getById('p1');
  assertEquals(before?.lastEgressIp, '203.0.113.1');

  const resp = await requestApp('/api/proxies/p1', patchAuthed(adminKey, { url: SOCKS_URL }));
  assertEquals(resp.status, 200);
  const updated = (await resp.json()) as ProxyJson;
  assertEquals(updated.url, SOCKS_URL);
  assertEquals(updated.last_egress_ip, null);
  assertEquals(updated.last_tested_at, null);

  const after = await repo.proxies.getById('p1');
  assertEquals(after?.lastEgressIp, null);
  assertEquals(after?.lastTestedAt, null);
});

test('DELETE /api/proxies/:id returns 204 when no upstream references the proxy', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_del', name: 'Doomed', url: HTTP_URL, sortOrder: 0 });

  const resp = await requestApp('/api/proxies/p_del', deleteAuthed(adminKey));
  assertEquals(resp.status, 204);
  assertEquals(await repo.proxies.getById('p_del'), null);
});

test('DELETE /api/proxies/:id returns 409 when an upstream references the proxy', async () => {
  const { repo, adminKey, copilotUpstream } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_ref', name: 'Referenced', url: HTTP_URL, sortOrder: 0 });
  await repo.upstreams.save({ ...copilotUpstream, proxyFallbackList: ['p_ref'] });

  const resp = await requestApp('/api/proxies/p_ref', deleteAuthed(adminKey));
  assertEquals(resp.status, 409);
  const body = (await resp.json()) as { error?: string; referencing_upstream_ids?: string[] };
  assertEquals(body.referencing_upstream_ids, [copilotUpstream.id]);
  assertExists(await repo.proxies.getById('p_ref'));
});

test('POST /api/proxies/:id/test surfaces the dial error in the ok:false response shape', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxies.insert({ id: 'p_test', name: 'Test', url: HTTP_URL, sortOrder: 0 });

  const resp = await requestApp('/api/proxies/p_test/test', authed(adminKey, {}));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { ok: boolean; error?: string; egress_ip?: string };
  assertEquals(body.ok, false);
  assertEquals(typeof body.error, 'string');
  // The HTTP CONNECT runner wraps the underlying SocketDial rejection with
  // "tcp connect to <host>:<port> failed". The exact upstream cause is the
  // stubbed Error but only the wrapping makes it into the message — that's
  // still the actionable surface (operator sees which dial leg failed).
  assertEquals(body.error?.includes('tcp connect to 198.51.100.20:3128 failed'), true);

  // The handler must not record a fake egress ip on failure.
  const stored = await repo.proxies.getById('p_test');
  assertEquals(stored?.lastEgressIp, null);
});

test('POST /api/proxies/:id/test returns 404 for an unknown proxy', async () => {
  const { adminKey } = await setupAppTest();
  const resp = await requestApp('/api/proxies/unknown/test', authed(adminKey, {}));
  assertEquals(resp.status, 404);
});

test('GET /api/proxies/:id/backoffs returns rows scoped to the proxy', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_a', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs', authed(adminKey));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as Array<{ proxy_id: string; upstream_id: string; fail_count: number; last_error: string | null }>;
  assertEquals(rows.length, 1);
  assertEquals(rows[0].proxy_id, 'p_a');
  assertEquals(rows[0].upstream_id, 'up_a');
  assertEquals(rows[0].fail_count, 1);
  assertEquals(rows[0].last_error, 'boom');
});

test('GET /api/proxies/backoffs returns every backoff row regardless of proxy', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_a', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_b', 'kaboom');

  const resp = await requestApp('/api/proxies/backoffs', authed(adminKey));
  assertEquals(resp.status, 200);
  const rows = (await resp.json()) as Array<{ proxy_id: string; upstream_id: string }>;
  assertEquals(rows.length, 2);
  const pairs = rows.map(r => `${r.proxy_id}/${r.upstream_id}`).sort();
  assertEquals(pairs, ['p_a/up_a', 'p_b/up_b']);
});

test('POST /api/proxies/:id/backoffs/reset with no body clears every row for the proxy', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_b', 'up_x', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminKey, {}));
  assertEquals(resp.status, 200);
  assertEquals(await resp.json(), { ok: true });

  assertEquals((await repo.proxyBackoffs.listForProxy('p_a')).length, 0);
  assertEquals((await repo.proxyBackoffs.listForProxy('p_b')).length, 1);
});

test('POST /api/proxies/:id/backoffs/reset with upstream_id clears only the matching pair', async () => {
  const { repo, adminKey } = await setupAppTest();
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_x', 'boom');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'up_y', 'boom');

  const resp = await requestApp('/api/proxies/p_a/backoffs/reset', authed(adminKey, { upstream_id: 'up_x' }));
  assertEquals(resp.status, 200);

  const rows = await repo.proxyBackoffs.listForProxy('p_a');
  assertEquals(rows.length, 1);
  assertEquals(rows[0].upstreamId, 'up_y');
});
