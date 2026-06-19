import { test } from 'vitest';

import { requestApp, setupAppTest } from '../../test-helpers.ts';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

type JsonObject = Record<string, any>;

const customConfig = {
  baseUrl: 'https://custom.example.com',
  bearerToken: 'sk-test',
  endpoints: { chatCompletions: {} },
};

const azureConfig = {
  endpoint: 'https://example.openai.azure.com',
  apiKey: 'az-secret',
  models: [
    {
      upstreamModelId: 'gpt-prod',
      publicModelId: 'gpt-public',
      endpoints: { chatCompletions: {}, responses: {} },
    },
  ],
};

const copilotConfig = {
  githubToken: 'ghu_secret',
  accountType: 'individual',
  user: {
    id: 12345,
    login: 'octo',
    name: null,
    avatar_url: 'https://example.com/octo.png',
  },
};

const createBody = (overrides: Record<string, unknown> = {}) => ({
  provider: 'custom',
  name: 'Test custom upstream',
  config: customConfig,
  flag_overrides: {},
  ...overrides,
});

const authed = (adminSession: string, body?: unknown): RequestInit => ({
  method: body === undefined ? 'GET' : 'POST',
  headers: {
    'content-type': 'application/json',
    'x-floway-session': adminSession,
  },
  ...(body === undefined ? {} : { body: JSON.stringify(body) }),
});

test('POST /api/upstreams creates custom upstreams and redacts bearer tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({ flag_overrides: { 'vendor-kimi': true } })));

  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.provider, 'custom');
  assertEquals(created.config.bearerToken, undefined);
  assertEquals(created.config.bearerTokenSet, true);
  assertEquals(created.config.baseUrl, 'https://custom.example.com');
  assertEquals(created.flag_overrides, { 'vendor-kimi': true });

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).bearerToken, 'sk-test');

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  const items = (await list.json()) as JsonObject[];
  assertEquals(items[0].config.bearerToken, undefined);
});

test('POST /api/upstreams validates Azure models and redacts API keys', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const invalid = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', config: { ...azureConfig, models: [] } })));
  assertEquals(invalid.status, 400);
  const invalidBody = (await invalid.json()) as { error?: string };
  assertEquals(invalidBody.error?.includes('models must be a non-empty array'), true);

  const createdResp = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', name: 'Azure', config: azureConfig })));
  assertEquals(createdResp.status, 201);
  const created = (await createdResp.json()) as JsonObject;
  assertEquals(created.provider, 'azure');
  assertEquals(created.config.apiKey, undefined);
  assertEquals(created.config.apiKeySet, true);
  assertEquals(created.config.endpoint, 'https://example.openai.azure.com');
  assertEquals(created.config.models[0].upstreamModelId, 'gpt-prod');
});

test('POST /api/upstreams creates Copilot upstream rows with redacted GitHub tokens', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stub every outbound request: the post-save warm tries to mint a Copilot
  // token + fetch the model catalog, neither of which the test cares about.
  // 403 is the terminal status the Copilot auth retry loop short-circuits on,
  // so the warm fails fast instead of burning ~7s of exponential backoff.
  const created = await withMockedFetch(
    () => jsonResponse({ error: 'forbidden' }, 403),
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'copilot', name: 'Copilot', config: copilotConfig })));
      assertEquals(resp.status, 201);
      const body = (await resp.json()) as JsonObject;
      return body;
    },
  );
  assertEquals(created.provider, 'copilot');
  assertEquals(created.config.githubToken, undefined);
  assertEquals(created.config.githubTokenSet, true);
  assertEquals(created.config.user.id, 12345);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals((stored?.config as Record<string, unknown>).githubToken, 'ghu_secret');
});

test('PATCH /api/upstreams rejects provider changes and preserves the row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({ provider: 'azure' }),
  });

  assertEquals(patch.status, 400);
  assertEquals(((await patch.json()) as { error?: string }).error, 'provider cannot be changed');
  assertEquals((await repo.upstreams.getById(created.id))?.provider, 'custom');
});

test('PATCH /api/upstreams preserves omitted secrets and re-warms the models cache', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as Record<string, string>;
  // Plant a stale row so the post-PATCH read can verify the warm overwrote
  // it with the new upstream-supplied catalog rather than leaving the old
  // models in place.
  await repo.modelsCache.put(created.id, {
    fetchedAt: 1,
    models: [{ id: 'stale-model', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: {
          'content-type': 'application/json',
          'x-floway-session': adminSession,
        },
        body: JSON.stringify({ config: { endpoints: { responses: {} } } }),
      });
      assertEquals(patch.status, 200);
    },
  );

  const updated = await repo.upstreams.getById(created.id);
  assertEquals((updated?.config as Record<string, unknown>).bearerToken, 'sk-test');
  assertEquals((updated?.config as Record<string, unknown>).endpoints, { responses: {} });

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['fresh-model']);
  assertEquals(cached!.fetchedAt > 1, true);
});

test('PATCH /api/upstreams keeps Azure as a single endpoint config', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_azure_single_endpoint',
    provider: 'azure',
    name: 'Azure Single Endpoint',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: {
      endpoint: 'https://example.openai.azure.com/openai/v1',
      apiKey: 'az-secret',
      models: [{ upstreamModelId: 'gpt-prod', endpoints: { messages: {} } }],
    },
    state: null,
  });

  const patch = await requestApp('/api/upstreams/up_azure_single_endpoint', {
    method: 'PATCH',
    headers: {
      'content-type': 'application/json',
      'x-floway-session': adminSession,
    },
    body: JSON.stringify({
      config: {
        models: [{ upstreamModelId: 'gpt-prod', endpoints: { responses: {} } }],
      },
    }),
  });

  assertEquals(patch.status, 200);
  const stored = await repo.upstreams.getById('up_azure_single_endpoint');
  assertEquals(stored?.config, {
    endpoint: 'https://example.openai.azure.com/openai/v1',
    apiKey: 'az-secret',
    models: [{ upstreamModelId: 'gpt-prod', kind: 'chat', endpoints: { responses: {} } }],
  });
});

test('GET /api/upstreams attaches models-cache freshness to every row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Three upstreams cover the three cache states: no row, warm row, warm row
  // with a follow-up failure annotated via setLastError.
  const baseRow = {
    provider: 'custom' as const,
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-06-01T00:00:00.000Z',
    updatedAt: '2026-06-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { baseUrl: 'https://a.example.com', bearerToken: 'x', endpoints: { chatCompletions: {} } },
    state: null,
  };
  await repo.upstreams.save({ ...baseRow, id: 'up_fresh', name: 'Fresh', sortOrder: 0 });
  await repo.upstreams.save({ ...baseRow, id: 'up_warm', name: 'Warm', sortOrder: 1 });
  await repo.upstreams.save({ ...baseRow, id: 'up_failed', name: 'Failed', sortOrder: 2 });

  await repo.modelsCache.put('up_warm', {
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.modelsCache.put('up_failed', {
    fetchedAt: 1_700_000_000_000,
    models: [{ id: 'm1', kind: 'chat', endpoints: {}, enabledFlags: new Set(), limits: {} }],
  });
  await repo.modelsCache.setLastError('up_failed', { message: 'boom', at: 1_700_000_500_000 });

  const list = await requestApp('/api/upstreams', { headers: { 'x-floway-session': adminSession } });
  assertEquals(list.status, 200);
  const items = (await list.json()) as JsonObject[];
  const byId = Object.fromEntries(items.map(i => [i.id, i]));

  assertEquals(byId.up_fresh.modelsCache, { fetchedAt: null, lastError: null });
  assertEquals(byId.up_warm.modelsCache, { fetchedAt: 1_700_000_000_000, lastError: null });
  assertEquals(byId.up_failed.modelsCache, {
    fetchedAt: 1_700_000_000_000,
    lastError: { message: 'boom', at: 1_700_000_500_000 },
  });
});

test('GET /api/upstream-flags returns the flag catalog and requires admin auth', async () => {
  const { adminSession, apiKey } = await setupAppTest();

  const resp = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const catalog = (await resp.json()) as Array<Record<string, unknown>>;
  const sample = catalog.find(e => e.id === 'vendor-kimi');
  assertEquals(typeof sample?.label, 'string');
  assertEquals(Array.isArray(sample!.defaultFor), true);
  // appliesTo is not part of the catalog shape; guard against silent re-introduction.
  assertEquals('appliesTo' in sample!, false);

  const forbidden = await requestApp('/api/upstream-flags', { method: 'GET', headers: { 'x-api-key': apiKey.key } });
  assertEquals(forbidden.status, 403);
});

test('GET /api/upstream-options returns the minimal picker shape to admin and non-admin callers', async () => {
  const { repo, adminSession, apiKey } = await setupAppTest();
  await repo.upstreams.save({
    id: 'up_disabled_custom',
    provider: 'custom',
    name: 'Disabled Custom',
    enabled: false,
    sortOrder: 5,
    createdAt: '2026-05-01T00:00:00.000Z',
    updatedAt: '2026-05-01T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { baseUrl: 'https://custom.example.com', bearerToken: 'sk-secret', endpoints: { chatCompletions: {} } },
    state: null,
  });

  const expected = [
    { id: 'up_copilot', name: 'GitHub Copilot (tester)', provider: 'copilot', enabled: true },
    { id: 'up_disabled_custom', name: 'Disabled Custom', provider: 'custom', enabled: false },
  ];

  const adminResp = await requestApp('/api/upstream-options', { headers: { 'x-floway-session': adminSession } });
  assertEquals(adminResp.status, 200);
  assertEquals(await adminResp.json(), expected);

  const userResp = await requestApp('/api/upstream-options', { headers: { 'x-api-key': apiKey.key } });
  assertEquals(userResp.status, 200);
  const userBody = await userResp.json() as Array<Record<string, unknown>>;
  assertEquals(userBody, expected);
  // No secret-bearing or operator-only fields leak through this endpoint.
  for (const row of userBody) {
    assertEquals(Object.keys(row).sort(), ['enabled', 'id', 'name', 'provider']);
  }
});

test('POST /api/upstreams/fetch-models fetches a draft custom upstream model list', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        assertEquals(request.headers.get('authorization'), 'Bearer sk-test');
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-a' }, { id: 'gpt-b', display_name: 'GPT B' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { config: customConfig }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['gpt-a', 'gpt-b']);
      assertEquals(body.data[1].display_name, 'GPT B');
    },
  );
});

test('POST /api/upstreams/fetch-models rejects calls that supply a saved upstream id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_stored_secret',
    provider: 'custom',
    name: 'Stored Secret Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { ...customConfig, bearerToken: 'sk-stored-secret' },
    state: null,
  });

  // Saved upstreams must go through GET /api/upstreams/:id/models?refresh=true
  // (the SWR-cached path); fetch-models stays draft-only.
  const resp = await requestApp(
    '/api/upstreams/fetch-models',
    authed(adminSession, { id: 'up_stored_secret', config: { ...customConfig, bearerToken: '' } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { message: string; type: string } };
  assertEquals(body.error.type, 'invalid_request_error');
  assertEquals(body.error.message.includes('refresh=true'), true);
});

test('POST /api/upstreams/fetch-models surfaces upstream model-listing failures as 502', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'unauthorized' }, 401);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { config: customConfig }));
      assertEquals(resp.status, 502);
      const body = (await resp.json()) as { error: { message: string; type: string } };
      assertEquals(body.error.type, 'api_error');
    },
  );
});

test('POST /api/upstreams/fetch-models rejects a malformed draft config with 400', async () => {
  const { adminSession } = await setupAppTest();

  // Blank token with no id and no stored secret to substitute: the runtime
  // assert rejects the empty bearerToken, surfaced as a 400 validation error.
  const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { config: { ...customConfig, bearerToken: '' } }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('bearerToken'), true);
});

test('GET /api/upstreams/:id/models?refresh=true forces a fresh upstream fetch', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_refresh',
    provider: 'custom',
    name: 'Refresh Custom',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-05-22T00:00:00.000Z',
    updatedAt: '2026-05-22T00:00:00.000Z',
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { ...customConfig, bearerToken: 'sk-refresh' },
    state: null,
  });
  // SOFT-fresh row: without ?refresh=true the cache returns it verbatim.
  await repo.modelsCache.put('up_refresh', {
    fetchedAt: Date.now(),
    models: [{ id: 'cached-model', kind: 'chat', endpoints: { chatCompletions: {} }, enabledFlags: new Set(), limits: {} }],
  });

  let upstreamCalls = 0;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        upstreamCalls += 1;
        return jsonResponse({ object: 'list', data: [{ id: 'fresh-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const cached = await requestApp('/api/upstreams/up_refresh/models', { headers: { 'x-floway-session': adminSession } });
      assertEquals(cached.status, 200);
      const cachedBody = (await cached.json()) as { data: Array<{ upstreamModelId: string }> };
      assertEquals(cachedBody.data.map(m => m.upstreamModelId), ['cached-model']);
      assertEquals(upstreamCalls, 0);

      const refreshed = await requestApp('/api/upstreams/up_refresh/models?refresh=true', { headers: { 'x-floway-session': adminSession } });
      assertEquals(refreshed.status, 200);
      const refreshedBody = (await refreshed.json()) as { data: Array<{ upstreamModelId: string }> };
      assertEquals(refreshedBody.data.map(m => m.upstreamModelId), ['fresh-model']);
      assertEquals(upstreamCalls, 1);
    },
  );

  const stored = await repo.modelsCache.get('up_refresh');
  assertEquals(stored?.models.map(m => m.id), ['fresh-model']);
});

test('GET /api/upstreams/:id/models resolves a saved upstream catalog and 404s for an unknown id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody({ provider: 'azure', name: 'Az', config: azureConfig })))).json()) as { id: string };

  const resp = await requestApp(`/api/upstreams/${created.id}/models`, { headers: { 'x-floway-session': adminSession } });
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { data: Array<{ upstreamModelId: string; kind: string; endpoints: Record<string, unknown> }> };
  assertEquals(body.data[0].upstreamModelId, 'gpt-public');
  assertEquals(body.data[0].kind, 'chat');

  const missing = await requestApp('/api/upstreams/nope/models', { headers: { 'x-floway-session': adminSession } });
  assertEquals(missing.status, 404);
});

test('POST /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-create' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams', authed(adminSession, createBody()));
      assertEquals(resp.status, 201);
      return (await resp.json()) as { id: string };
    },
  );

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['warmed-on-create']);
});

test('PATCH /api/upstreams warms the models cache before responding', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };
  // Drop whatever the create-time warm landed on disk so the PATCH-time warm
  // is the only writer in this test's window.
  await repo.modelsCache.delete(created.id);

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'warmed-on-update' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const patch = await requestApp(`/api/upstreams/${created.id}`, {
        method: 'PATCH',
        headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
        body: JSON.stringify({ name: 'Renamed' }),
      });
      assertEquals(patch.status, 200);
    },
  );

  const cached = await repo.modelsCache.get(created.id);
  assertEquals(cached?.models.map(m => m.id), ['warmed-on-update']);
});

test('POST /api/upstreams/fetch-models without an id still serves draft preview', async () => {
  const { adminSession } = await setupAppTest();

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'draft-only' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp('/api/upstreams/fetch-models', authed(adminSession, { config: customConfig }));
      assertEquals(resp.status, 200);
      const body = (await resp.json()) as { data: Array<Record<string, unknown>> };
      assertEquals(body.data.map(m => m.id), ['draft-only']);
    },
  );
});

// --- Codex routes ---
//
// The auth.json import path lets us drive the OAuth ingestion deterministically
// without mocking the token-exchange roundtrip: parseCodexIdTokenClaims decodes
// the id_token JWT directly. Build a fake JWT that carries the identity claims
// the production parser requires.
const encodeBase64Url = (input: string): string =>
  btoa(input).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');

const fakeIdToken = (claims: Record<string, unknown>): string => {
  const header = encodeBase64Url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
  const payload = encodeBase64Url(JSON.stringify({
    'https://api.openai.com/auth': {
      chatgpt_account_id: 'acc_test',
      chatgpt_user_id: 'usr_test',
      chatgpt_plan_type: 'plus',
    },
    'https://api.openai.com/profile': { email: 'alice@example.com' },
    ...claims,
  }));
  return `${header}.${payload}.fake-signature`;
};

const codexAuthJsonImport = (overrides: Record<string, unknown> = {}) => ({
  name: 'ChatGPT Codex',
  auth_json: JSON.stringify({
    tokens: {
      access_token: 'at_test',
      refresh_token: 'rt_test',
      id_token: fakeIdToken({}),
    },
    ...overrides,
  }),
});

test('POST /api/upstreams/codex-pkce-start returns an authorize URL and stashes the verifier', async () => {
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex-pkce-start', authed(adminSession, {}));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { state: string; authorize_url: string; expires_in_seconds: number };
  assertEquals(typeof body.state, 'string');
  assertEquals(body.authorize_url.startsWith('https://auth.openai.com/oauth/authorize?'), true);
  assertEquals(body.expires_in_seconds, 300);

  const stashed = await repo.codexPkcePending.consume(body.state);
  assertEquals(stashed !== null, true);
  assertEquals(typeof stashed!.verifier, 'string');
});

test('POST /api/upstreams/codex-import (callback) consumes the PKCE state and returns the verifier exchange result', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const startResp = await requestApp('/api/upstreams/codex-pkce-start', authed(adminSession, {}));
  const { state } = (await startResp.json()) as { state: string };

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_cb', refresh_token: 'rt_cb', id_token: fakeIdToken({}), expires_in: 600 }),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/codex-import',
        authed(adminSession, { name: 'ChatGPT Codex', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { provider: string; state: { accounts: Array<{ refresh_token_set: boolean }> } };
      assertEquals(created.provider, 'codex');
      assertEquals(created.state.accounts[0].refresh_token_set, true);
    },
  );

  const replay = await repo.codexPkcePending.consume(state);
  assertEquals(replay, null);
});

test('POST /api/upstreams/codex-import rejects a replayed PKCE callback', async () => {
  const { adminSession } = await setupAppTest();

  const startResp = await requestApp('/api/upstreams/codex-pkce-start', authed(adminSession, {}));
  const { state } = (await startResp.json()) as { state: string };

  await withMockedFetch(
    () => jsonResponse({ access_token: 'at_cb', refresh_token: 'rt_cb', id_token: fakeIdToken({}), expires_in: 600 }),
    async () => {
      const first = await requestApp(
        '/api/upstreams/codex-import',
        authed(adminSession, { name: 'ChatGPT Codex', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(first.status, 201);

      const replay = await requestApp(
        '/api/upstreams/codex-import',
        authed(adminSession, { name: 'ChatGPT Codex', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(replay.status, 400);
      const body = (await replay.json()) as { error: string };
      assertEquals(body.error.includes('PKCE state not found or expired'), true);
    },
  );
});

test('POST /api/upstreams/codex-import rejects an expired PKCE state', async () => {
  const { repo, adminSession } = await setupAppTest();

  // Plant a pending row that has already expired so the consume() filter drops it.
  const expiredState = 'expired_state';
  await repo.codexPkcePending.put(expiredState, 'verifier_x', Date.now() - 1000);

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { name: 'ChatGPT Codex', callback: { code: 'AUTH_CODE', state: expiredState } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('PKCE state not found or expired'), true);
});

test('POST /api/upstreams/codex-import (auth_json) creates a codex upstream with state', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.provider, 'codex');
  assertEquals(created.config.accounts[0].email, 'alice@example.com');
  assertEquals(created.config.accounts[0].chatgptAccountId, 'acc_test');
  assertEquals(created.config.accounts[0].planType, 'plus');
  assertEquals(created.state.accounts[0].state, 'active');
  assertEquals(created.state.accounts[0].refresh_token_set, true);

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_test');
});

test('POST /api/upstreams/codex-import without an explicit name auto-derives one from the imported identity', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, { auth_json: codexAuthJsonImport().auth_json }));
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as { name: string };
  assertEquals(created.name, 'ChatGPT Codex (alice@example.com)');
});

test('POST /api/upstreams/codex-import rejects when both auth_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/codex-import', authed(adminSession, { name: 'ChatGPT Codex' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: { issues?: Array<{ message: string }> } | string };
  // The schema-level XOR refine surfaces as a zod validation error envelope.
  assertEquals(JSON.stringify(body).includes('Provide exactly one of auth_json or callback'), true);
});

test('POST /api/upstreams/codex-import rejects a malformed PKCE callback URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/codex-import',
    authed(adminSession, { name: 'Codex', callback: { callback_url: 'http://localhost:1455/auth/callback' } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('missing'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects non-codex rows with 404', async () => {
  const { adminSession } = await setupAppTest();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json()) as { id: string };
  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/:id/codex-refresh-now rejects upstreams in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a codex upstream in `session_terminated` state by importing then
  // hand-mutating the row (the routes never expose a way to get into this
  // state without a real upstream 401).
  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: { accounts: storedState.accounts.map(a => ({ ...a, state: 'session_terminated' })) },
  });

  const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('session_terminated'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now rotates the refresh token on success', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => jsonResponse({
      access_token: 'at_rotated',
      refresh_token: 'rt_rotated',
      id_token: fakeIdToken({}),
      expires_in: 3600,
    }),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refresh_token: string }> };
  assertEquals(storedState.accounts[0].refresh_token, 'rt_rotated');
});

test('POST /api/upstreams/:id/codex-refresh-now flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      // 400, not 502: the upstream answered — it's the stored credential
      // that's dead. Not 401 either, since the dashboard's auth client
      // treats any 401 as a logout signal.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; state_message?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].state_message, 'string');
});

test('POST /api/upstreams/:id/codex-refresh-now still answers when the failure-state CAS write loses to a concurrent mutation', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  // Race: another writer rotates the refresh_token between our read and our
  // failure-state CAS write. The route should still respond — the concurrent
  // writer's state is fresher than our `refresh_failed` proposal by
  // construction, so we drop ours rather than overwrite theirs.
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };

  await withMockedFetch(
    async () => {
      // Simulate the concurrent writer mid-OAuth by mutating the row before
      // the route reaches its CAS write. The OAuth call itself fails terminally.
      await repo.upstreams.save({
        ...stored!,
        state: { accounts: storedState.accounts.map(a => ({ ...a, refresh_token: 'rt_concurrent_winner' })) },
      });
      return new Response(
        JSON.stringify({ error: { code: 'invalid_grant', message: 'Your refresh token has already been used to generate a new access token.' } }),
        { status: 400, headers: { 'content-type': 'application/json' } },
      );
    },
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/codex-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 400);
    },
  );

  // The concurrent writer's state survives — our refresh_failed write was
  // dropped by the CAS guard, which is the intended best-effort behavior.
  const after = await repo.upstreams.getById(created.id);
  const afterState = after?.state as { accounts: Array<{ state: string; refresh_token: string }> };
  assertEquals(afterState.accounts[0].refresh_token, 'rt_concurrent_winner');
  assertEquals(afterState.accounts[0].state, 'active');
});

// --- Claude Code routes ---
//
// Test setup mirrors the codex routes: we drive the OAuth + profile fetches
// through withMockedFetch so the import handler runs end-to-end without
// hitting the real upstream.

const claudeCodeProfileBody = {
  account: { uuid: 'acc-uuid-1', email: 'alice@example.com' },
  organization: { uuid: 'org-uuid-1', organization_type: 'claude_max', rate_limit_tier: 'default_claude_max_20x' },
};

const claudeCodeTokenBody = (overrides: Record<string, unknown> = {}) => ({
  access_token: 'at_test',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt_test',
  scope: 'user:inference',
  ...overrides,
});

const claudeCodeCredentialsJson = (overrides: { accessToken?: string; refreshToken?: string; expiresAt?: number } = {}) => JSON.stringify({
  claudeAiOauth: {
    accessToken: overrides.accessToken ?? 'cli_at',
    refreshToken: overrides.refreshToken ?? 'cli_rt',
    expiresAt: overrides.expiresAt ?? Date.now() + 3_600_000,
    subscriptionType: 'max_20x',
  },
});

test('POST /api/upstreams/claude-code-pkce-start returns an authorize URL and stashes the verifier', async () => {
  const { repo, adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code-pkce-start', authed(adminSession, {}));
  assertEquals(resp.status, 200);
  const body = (await resp.json()) as { state: string; authorize_url: string; expires_in_seconds: number };
  assertEquals(typeof body.state, 'string');
  assertEquals(body.authorize_url.startsWith('https://claude.ai/oauth/authorize?'), true);
  assertEquals(body.expires_in_seconds, 300);

  const stashed = await repo.claudeCodePkcePending.consume(body.state);
  assertEquals(stashed !== null, true);
  assertEquals(typeof stashed!.verifier, 'string');
});

test('POST /api/upstreams/claude-code-import (callback) consumes the PKCE state and returns the verifier exchange result', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const startResp = await requestApp('/api/upstreams/claude-code-pkce-start', authed(adminSession, {}));
  const { state } = (await startResp.json()) as { state: string };

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeTokenBody());
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return jsonResponse(claudeCodeProfileBody);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { name: 'Claude Code', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { provider: string; state: { accounts: Array<{ refreshTokenSet: boolean; accessToken: { expiresAt: number } | null }> } };
      assertEquals(created.provider, 'claude-code');
      assertEquals(created.state.accounts[0].refreshTokenSet, true);
      assertEquals(typeof created.state.accounts[0].accessToken?.expiresAt, 'number');
    },
  );

  const replay = await repo.claudeCodePkcePending.consume(state);
  assertEquals(replay, null);
});

test('POST /api/upstreams/claude-code-import rejects a replayed PKCE callback', async () => {
  const { adminSession } = await setupAppTest();

  const startResp = await requestApp('/api/upstreams/claude-code-pkce-start', authed(adminSession, {}));
  const { state } = (await startResp.json()) as { state: string };

  await withMockedFetch(
    async (request: Request) => {
      if (request.url === 'https://platform.claude.com/v1/oauth/token') return jsonResponse(claudeCodeTokenBody());
      if (request.url === 'https://api.anthropic.com/api/oauth/profile') return jsonResponse(claudeCodeProfileBody);
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const first = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { name: 'Claude Code', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(first.status, 201);

      const replay = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { name: 'Claude Code', callback: { code: 'AUTH_CODE', state } }),
      );
      assertEquals(replay.status, 400);
      const body = (await replay.json()) as { error: string };
      assertEquals(body.error.includes('PKCE state not found or expired'), true);
    },
  );
});

test('POST /api/upstreams/claude-code-import (credentials_json) creates a row with the cached access token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as JsonObject;
      assertEquals(created.provider, 'claude-code');
      assertEquals(created.config.accounts[0].email, 'alice@example.com');
      assertEquals(created.config.accounts[0].accountUuid, 'acc-uuid-1');
      // CLI subscriptionType verbatim wins over what the profile endpoint
      // would derive.
      assertEquals(created.config.accounts[0].subscriptionType, 'max_20x');
      assertEquals(created.state.accounts[0].state, 'active');
      assertEquals(created.state.accounts[0].refreshTokenSet, true);
    },
  );
});

test('POST /api/upstreams/claude-code-import without an explicit name auto-derives one from the imported email', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const resp = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      assertEquals(resp.status, 201);
      const created = (await resp.json()) as { name: string };
      assertEquals(created.name, 'Claude Code (alice@example.com)');
    },
  );
});

test('POST /api/upstreams/claude-code-import rejects when both credentials_json and callback are absent', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams/claude-code-import', authed(adminSession, { name: 'Claude Code' }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as unknown;
  assertEquals(JSON.stringify(body).includes('Provide exactly one of credentials_json or callback'), true);
});

test('POST /api/upstreams/claude-code-import rejects a malformed callback URL', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp(
    '/api/upstreams/claude-code-import',
    authed(adminSession, { name: 'Claude Code', callback: { callback_url: 'https://platform.claude.com/oauth/code/callback' } }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('missing'), true);
});

test('PATCH /api/upstreams rejects config edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ config: { accounts: [] } }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.includes('claude-code-reimport'), true);
});

test('PATCH /api/upstreams accepts metadata edits on a claude-code row', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ name: 'My Claude Max', enabled: false }),
  });
  assertEquals(patch.status, 200);
  const body = (await patch.json()) as { name: string; enabled: boolean };
  assertEquals(body.name, 'My Claude Max');
  assertEquals(body.enabled, false);
});

test('POST /api/upstreams rejects a direct claude-code create with a redirect message', async () => {
  const { adminSession } = await setupAppTest();

  const resp = await requestApp('/api/upstreams', authed(adminSession, {
    provider: 'claude-code',
    name: 'Claude Code',
    config: {},
  }));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('claude-code-import'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rejects non-claude-code rows with 404', async () => {
  const { adminSession } = await setupAppTest();

  const created = (await (await requestApp('/api/upstreams', authed(adminSession, createBody()))).json()) as { id: string };
  const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 404);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rejects upstreams in a terminal state with 400', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Plant a row in `refresh_failed` by importing then hand-mutating the row.
  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );
  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored!.state as { accounts: Array<Record<string, unknown>> };
  await repo.upstreams.save({
    ...stored!,
    state: {
      accounts: storedState.accounts.map(a => ({
        ...a,
        state: 'refresh_failed',
        stateMessage: 'token revoked',
        accessToken: null,
      })),
    },
  });

  const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.includes('refresh_failed'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now rotates the refresh token on success', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ refreshToken: string }> };
  assertEquals(storedState.accounts[0].refreshToken, 'rt_rotated');
});

test('POST /api/upstreams/:id/claude-code-refresh-now flips the row to refresh_failed when OAuth rejects the refresh_token', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  await withMockedFetch(
    () => new Response(
      JSON.stringify({ error: { code: 'invalid_grant', message: 'Refresh token revoked' } }),
      { status: 400, headers: { 'content-type': 'application/json' } },
    ),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      // 400, not 502: same reasoning as codex — the upstream answered,
      // it's the stored credential that's dead. Not 401 either, to avoid
      // logging the operator out of the dashboard.
      assertEquals(resp.status, 400);
      const body = await resp.json() as { error: string };
      assertEquals(body.error.includes('Re-import'), true);
    },
  );

  const stored = await repo.upstreams.getById(created.id);
  const storedState = stored?.state as { accounts: Array<{ state: string; stateMessage?: string }> };
  assertEquals(storedState.accounts[0].state, 'refresh_failed');
  assertEquals(typeof storedState.accounts[0].stateMessage, 'string');
});

// --- proxy_fallback_list ---
//
// The list has set semantics — duplicates are dropped silently before
// storage. Order is meaningful at dial time. Both POST and PATCH normalize
// the list so the wire response matches what GET returns afterwards.

test('POST /api/upstreams accepts proxy_fallback_list and surfaces it in the response', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: ['p_fallback', 'direct'] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  assertEquals(created.proxy_fallback_list, ['p_fallback', 'direct']);

  const stored = await repo.upstreams.getById(created.id);
  assertEquals(stored?.proxyFallbackList, ['p_fallback', 'direct']);
});

test('POST /api/upstreams normalises proxy_fallback_list duplicates so the response matches what GET returns', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const resp = await requestApp(
    '/api/upstreams',
    authed(adminSession, createBody({ proxy_fallback_list: ['p_fallback', 'direct', 'p_fallback', 'direct'] })),
  );
  assertEquals(resp.status, 201);
  const created = (await resp.json()) as JsonObject;
  // Without the API-layer normalize, the response would echo the duplicates
  // while the saved row only kept one of each — operators would see a
  // different list on POST vs the next GET.
  assertEquals(created.proxy_fallback_list, ['p_fallback', 'direct']);

  const get = await requestApp('/api/upstreams', authed(adminSession));
  const list = (await get.json()) as JsonObject[];
  const fresh = list.find(u => u.id === created.id);
  assertEquals(fresh!.proxy_fallback_list, ['p_fallback', 'direct']);
});

test('PATCH /api/upstreams sets proxy_fallback_list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_fallback', name: 'Fallback', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string; proxy_fallback_list: string[] };
  assertEquals(created.proxy_fallback_list, []);

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: ['p_fallback', 'direct'] }),
  });
  assertEquals(patch.status, 200);
  const updated = (await patch.json()) as JsonObject;
  assertEquals(updated.proxy_fallback_list, ['p_fallback', 'direct']);
});

test('PATCH /api/upstreams rejects proxy_fallback_list referencing an unknown proxy id', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody()));
  const created = (await create.json()) as { id: string };

  const patch = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json', 'x-floway-session': adminSession },
    body: JSON.stringify({ proxy_fallback_list: ['nope'] }),
  });
  assertEquals(patch.status, 400);
  const body = (await patch.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('DELETE /api/upstreams sweeps orphaned proxy backoff rows', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.proxies.insert({ id: 'p_a', name: 'A', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const create = await requestApp('/api/upstreams', authed(adminSession, createBody({ proxy_fallback_list: ['p_a'] })));
  const created = (await create.json()) as { id: string };

  await repo.proxyBackoffs.recordDialFailure('p_a', created.id, 'tcp refused');
  await repo.proxyBackoffs.recordDialFailure('p_a', 'other_upstream', 'tcp refused');
  assertEquals((await repo.proxyBackoffs.listAll()).length, 2);

  const del = await requestApp(`/api/upstreams/${created.id}`, {
    method: 'DELETE',
    headers: { 'x-floway-session': adminSession },
  });
  assertEquals(del.status, 200);

  const remaining = await repo.proxyBackoffs.listAll();
  assertEquals(remaining.length, 1);
  assertEquals(remaining[0]!.upstreamId, 'other_upstream');
});

test('POST /api/upstreams/:id/claude-code-refresh-now honors the proxy_fallback_list override over the persisted list', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  // Stash a real proxy id so the persisted list has a non-direct entry; the
  // override below points at a different (unknown) id, so a 400 from the
  // route proves the override won — not the persisted row.
  await repo.proxies.insert({ id: 'p_real', name: 'Real', url: 'socks5://198.51.100.10:1080', dialTimeoutSeconds: null });

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // Persist a non-direct fallback list so a successful default-path refresh
  // would route through `p_real`. The override below should win.
  await repo.upstreams.save({ ...(await repo.upstreams.getById(created.id))!, proxyFallbackList: ['p_real'] });

  const resp = await requestApp(
    `/api/upstreams/${created.id}/claude-code-refresh-now`,
    authed(adminSession, { proxy_fallback_list: ['p_unknown'] }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/:id/codex-refresh-now honors the proxy_fallback_list override', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = (await (await requestApp('/api/upstreams/codex-import', authed(adminSession, codexAuthJsonImport()))).json()) as { id: string };

  const resp = await requestApp(
    `/api/upstreams/${created.id}/codex-refresh-now`,
    authed(adminSession, { proxy_fallback_list: ['p_unknown'] }),
  );
  assertEquals(resp.status, 400);
  const body = (await resp.json()) as { error: string };
  assertEquals(body.error.toLowerCase().includes('unknown proxy id'), true);
});

test('POST /api/upstreams/:id/claude-code-refresh-now without an override falls back to the persisted list (no override → no validation failure)', async () => {
  const { repo, adminSession } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const created = await withMockedFetch(
    () => jsonResponse(claudeCodeProfileBody),
    async () => {
      const r = await requestApp(
        '/api/upstreams/claude-code-import',
        authed(adminSession, { credentials_json: claudeCodeCredentialsJson() }),
      );
      return (await r.json()) as { id: string };
    },
  );

  // Empty body → no override → persisted ([]) → direct egress → mocked fetch
  // serves the refresh response. A successful 200 proves the "no override"
  // path did not validate against the proxies table (it skipped validation
  // because no override was sent).
  await withMockedFetch(
    () => jsonResponse(claudeCodeTokenBody({ access_token: 'at_rotated', refresh_token: 'rt_rotated' })),
    async () => {
      const resp = await requestApp(`/api/upstreams/${created.id}/claude-code-refresh-now`, authed(adminSession, {}));
      assertEquals(resp.status, 200);
    },
  );
});
