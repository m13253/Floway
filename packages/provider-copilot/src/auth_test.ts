import { test } from 'vitest';

import { copilotAuthedFetch } from './auth.ts';
import { clearCopilotTokenCache } from './index.ts';
import type { CopilotUpstreamState } from './state.ts';
import { initProviderRepo, directFetcher, type UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, memoryCacheRepo, withMockedFetch } from '@floway-dev/test-utils';

const UPSTREAM_ID = 'up_copilot_test';

const installRepoAndClearCache = async () => {
  const cache = memoryCacheRepo();
  let state: unknown = null;
  const stub: UpstreamRecord = {
    id: UPSTREAM_ID,
    provider: 'copilot',
    name: 'auth-test',
    enabled: true,
    sortOrder: 0,
    createdAt: '2026-03-15T00:00:00.000Z',
    updatedAt: '2026-03-15T00:00:00.000Z',
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    config: { githubToken: 'ghu_test', accountType: 'individual', user: { id: 1, login: 't', name: null, avatar_url: '' } },
  };
  initProviderRepo(() => ({
    cache,
    upstreams: {
      getById: async () => ({ ...stub, state }),
      saveState: async (_id, newState) => {
        state = newState;
        return { updated: true };
      },
    },
  }));
  await clearCopilotTokenCache();
  return {
    readPersistedState: (): CopilotUpstreamState | null => state as CopilotUpstreamState | null,
  };
};

const mockTokenAndCapture = async (
  extraHeaders: Record<string, string> | undefined,
  assert: (headers: Headers) => void,
): Promise<void> => {
  await installRepoAndClearCache();
  let captured: Headers | null = null;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'tok-test', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 });
      }
      captured = new Headers(request.headers);
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test', accountType: 'individual' },
        extraHeaders ? { headers: extraHeaders, fetcher: directFetcher } : { fetcher: directFetcher },
      );
    },
  );

  if (!captured) throw new Error('upstream call never observed');
  assert(captured);
};

test('copilotAuthedFetch overlays interceptor headers on the pinned base set', async () => {
  await mockTokenAndCapture({ 'x-initiator': 'agent', 'copilot-vision-request': 'true' }, headers => {
    assertEquals(headers.get('x-initiator'), 'agent');
    assertEquals(headers.get('copilot-vision-request'), 'true');
    // Base headers we did not override stay pinned.
    assertEquals(headers.get('copilot-integration-id'), 'vscode-chat');
    assertEquals(headers.get('openai-intent'), 'conversation-agent');
  });
});

test('copilotAuthedFetch deletes a base header when the interceptor passes an empty-string value', async () => {
  // Sentinel contract: empty string means "drop this base header". This is
  // the deletion convention later workaround interceptors rely on; future
  // commits will add concrete callers (e.g. clearing copilot-integration-id
  // on Claude Code SDK proxy traffic).
  await mockTokenAndCapture({ 'copilot-integration-id': '' }, headers => {
    assertEquals(headers.has('copilot-integration-id'), false);
  });
});

test('copilotAuthedFetch persists the minted Copilot token into state_json.copilotToken', async () => {
  const harness = await installRepoAndClearCache();
  const expiresAt = Math.floor(Date.now() / 1000) + 3600;

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'tok-persisted', expires_at: expiresAt, refresh_in: 1800 });
      }
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      await copilotAuthedFetch(
        '/v1/messages',
        { method: 'POST', body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test', accountType: 'individual' },
        { fetcher: directFetcher },
      );
    },
  );

  const persisted = harness.readPersistedState();
  if (!persisted) throw new Error('expected state_json to be written');
  assertEquals(persisted.copilotToken?.token, 'tok-persisted');
  assertEquals(persisted.copilotToken?.expiresAt, expiresAt);
});

test('copilotAuthedFetch reads a still-valid Copilot token from state_json instead of refreshing', async () => {
  await installRepoAndClearCache();
  // Issue one request to populate state_json with a freshly minted token.
  let tokenFetches = 0;
  let upstreamFetches = 0;
  let authHeader: string | null = null;
  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      if (url.pathname === '/copilot_internal/v2/token') {
        tokenFetches++;
        return jsonResponse({ token: 'tok-persisted', expires_at: Math.floor(Date.now() / 1000) + 3600, refresh_in: 1800 });
      }
      upstreamFetches++;
      authHeader = request.headers.get('authorization');
      return new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
    },
    async () => {
      const args = [
        '/v1/messages',
        { method: 'POST' as const, body: '{}' },
        { id: UPSTREAM_ID, githubToken: 'ghu_test', accountType: 'individual' as const },
        { fetcher: directFetcher },
      ] as const;
      // First call mints the token and persists it.
      await copilotAuthedFetch(...args);
      // Drop the in-process memo so the second call has to consult state_json;
      // if state_json hydration works, the token endpoint won't be hit again.
      await clearCopilotTokenCache();
      await copilotAuthedFetch(...args);
    },
  );

  assertEquals(tokenFetches, 1);
  assertEquals(upstreamFetches, 2);
  assertEquals(authHeader, 'Bearer tok-persisted');
});
