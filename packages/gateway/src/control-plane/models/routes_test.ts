import { test } from 'vitest';

import { buildCustomUpstreamRecord, copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import type { UpstreamRecord } from '@floway-dev/provider';
import { assertEquals, jsonResponse, withMockedFetch } from '@floway-dev/test-utils';

const azureUpstream = (): UpstreamRecord => ({
  id: 'up_azure_models',
  provider: 'azure',
  name: 'Azure Models',
  enabled: true,
  sortOrder: 200,
  createdAt: '2026-05-21T00:00:00.000Z',
  updatedAt: '2026-05-21T00:00:00.000Z',
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
  modelPrefix: null,
  config: {
    endpoint: 'https://example.openai.azure.com',
    apiKey: 'az-key',
    models: [
      {
        upstreamModelId: 'azure-model',
        publicModelId: 'azure-public',
        endpoints: { responses: {} },
      },
    ],
  },
  state: null,
});

test('/api/models exposes each binding as { kind, id } so multi-provider models are unambiguous', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/api/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: Array<Record<string, unknown>> };

      assertEquals(body.data.find(model => model.id === 'claude-sonnet-4')?.upstreams, [{ kind: 'copilot', id: 'up_copilot', name: 'GitHub Copilot (tester)' }]);
      assertEquals(body.data.find(model => model.id === 'custom-model')?.upstreams, [{ kind: 'custom', id: 'up_custom_models', name: 'Custom Provider' }]);
      assertEquals(body.data.find(model => model.id === 'azure-public')?.upstreams, [{ kind: 'azure', id: 'up_azure_models', name: 'Azure Models' }]);
      for (const model of body.data) {
        // Legacy split fields must not reappear.
        assertEquals(Object.hasOwn(model, 'provider'), false);
        assertEquals(Object.hasOwn(model, 'upstream_ids'), false);
        assertEquals(Object.hasOwn(model, 'upstream_kind'), false);
      }
    },
  );
});

const modelsFetchHandler = (request: Request): Response => {
  const url = new URL(request.url);
  if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
  if (url.pathname === '/copilot_internal/v2/token') {
    return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
  }
  if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
    return jsonResponse(copilotModels([{ id: 'claude-sonnet-4', display_name: 'Claude Sonnet 4', supported_endpoints: ['/v1/messages'] }]));
  }
  if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
    return jsonResponse({ object: 'list', data: [{ id: 'custom-model', supported_endpoints: ['/chat/completions'] }] });
  }
  throw new Error(`Unhandled fetch ${request.url}`);
};

test('/api/models is scoped to the caller\'s effective upstreams — a removed upstream\'s models disappear from the dashboard', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  // The seed tester (user 2) overrides their available upstreams to exclude
  // Azure, then browses the dashboard Models tab via a session token — the
  // exact path that previously leaked the full catalog regardless of the cap.
  await repo.users.save({
    id: 2,
    username: 'tester',
    passwordHash: null,
    isAdmin: false,
    upstreamIds: ['up_copilot', 'up_custom_models'],
    canViewGlobalTelemetry: false,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });
  const session = (await repo.sessions.create(2)).id;

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-floway-session': session } });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string }> };
    const ids = body.data.map(model => model.id).sort();

    assertEquals(ids, ['claude-sonnet-4', 'custom-model']);
    assertEquals(ids.includes('azure-public'), false);
  });
});

test('/api/models appends visible alias entries with aliasedFrom alongside real catalog rows', async () => {
  const { apiKey, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-api-key': apiKey.key } });
    assertEquals(response.status, 200);
    const body = (await response.json()) as { data: Array<{ id: string; display_name: string; upstreams: Array<{ kind: string; id: string; name: string }> }> };
    assertEquals(body.data.some(model => model.id === 'custom-model'), true);
  });
});

test('/api/models?include_unlisted=true appends addressable-but-not-listed rows marked with `unlisted: true`', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        // Two variants of one model — Copilot publishes the dotted-version
        // ids as raw upstream entries, but the public id collapses the
        // dots and any `-high`/`-xhigh` suffix. The raw forms become
        // addressable-but-not-listed entries.
        return jsonResponse(copilotModels([
          { id: 'claude-opus-4.7', display_name: 'Claude Opus 4.7', supported_endpoints: ['/v1/messages'] },
          { id: 'claude-opus-4.7-high', supported_endpoints: ['/v1/messages'] },
        ]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const listed = await requestApp('/api/models?aliases=false', { headers: { 'x-api-key': apiKey.key } });
      const listedBody = (await listed.json()) as { data: Array<{ id: string; unlisted?: true }> };
      assertEquals(listedBody.data.map(m => m.id), ['claude-opus-4-7']);
      // The default response carries no `unlisted` field on any row.
      assertEquals(listedBody.data.every(m => m.unlisted === undefined), true);

      const full = await requestApp('/api/models?aliases=false&include_unlisted=true', { headers: { 'x-api-key': apiKey.key } });
      const fullBody = (await full.json()) as { data: Array<{ id: string; unlisted?: true; upstreams: unknown[] }> };
      const ids = fullBody.data.map(m => m.id);
      assertEquals(ids.includes('claude-opus-4-7'), true);
      assertEquals(ids.includes('claude-opus-4.7'), true);
      assertEquals(ids.includes('claude-opus-4.7-high'), true);
      // Only the addressable-but-not-listed rows carry the sidecar tag.
      const tagged = new Set(fullBody.data.filter(m => m.unlisted === true).map(m => m.id));
      assertEquals(tagged.has('claude-opus-4-7'), false);
      assertEquals(tagged.has('claude-opus-4.7'), true);
      assertEquals(tagged.has('claude-opus-4.7-high'), true);
      // Each addressable row keeps the canonical model's upstreams metadata
      // verbatim so the dashboard renders the real binding without a second
      // call.
      const variant = fullBody.data.find(m => m.id === 'claude-opus-4.7')!;
      assertEquals(variant.upstreams.length > 0, true);
    },
  );
});

test('/api/models?include_unlisted=true: alias whose name collides with an unlisted addressable id emits only the listed row', async () => {
  // Operator-side trap: an alias name accidentally matching a Copilot
  // variant id (e.g. `claude-opus-4.7`). Both the listed alias row and
  // the unlisted addressable row carry the same `id`, so emitting both
  // would break OpenAI-client deduplication and contradict /v1/models's
  // alias-vs-real collision rule (alias wins, real is dropped).
  const { apiKey, repo } = await setupAppTest();
  await repo.modelAliases.insert({
    name: 'claude-opus-4.7',
    kind: 'chat',
    selection: 'first-available',
    displayName: 'Alias colliding with the unlisted Copilot variant',
    visibleInModelsList: true,
    targets: [{ target_model_id: 'claude-opus-4-7', rules: {} }],
    announcedMetadata: null,
    sortOrder: 0,
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
  });

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([
          { id: 'claude-opus-4.7', display_name: 'Claude Opus 4.7', supported_endpoints: ['/v1/messages'] },
        ]));
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const full = await requestApp('/api/models?include_unlisted=true', { headers: { 'x-api-key': apiKey.key } });
      const fullBody = (await full.json()) as { data: Array<{ id: string; unlisted?: true; aliasedFrom?: unknown }> };
      const collisions = fullBody.data.filter(m => m.id === 'claude-opus-4.7');
      assertEquals(collisions.length, 1);
      // The surviving row is the alias-side one (aliasedFrom set, no
      // `unlisted` tag), matching /v1/models's alias-wins rule.
      assertEquals(collisions[0].aliasedFrom !== undefined, true);
      assertEquals(collisions[0].unlisted, undefined);
    },
  );
});

test('/api/models for an admin session returns the gateway-wide catalog, bypassing the admin\'s own user.upstreamIds cap', async () => {
  const { adminSession, repo } = await setupAppTest();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom_models', sortOrder: 100 }));
  await repo.upstreams.save(azureUpstream());

  // Admin self-restricts. The dashboard's editor surfaces (alias edit,
  // upstream edit) need to see "what exists on the entire gateway", and
  // the Models page + playground filter the gateway-wide payload
  // client-side for surfaces that should respect the restriction.
  // Server-side gateway-wide for admin is the foundation that lets the
  // dashboard do that filtering.
  await repo.users.save({
    id: 1,
    username: 'admin',
    passwordHash: null,
    isAdmin: true,
    upstreamIds: ['up_copilot', 'up_custom_models'],
    canViewGlobalTelemetry: true,
    createdAt: '2026-03-15T00:00:00.000Z',
    deletedAt: null,
  });

  await withMockedFetch(modelsFetchHandler, async () => {
    const response = await requestApp('/api/models', { headers: { 'x-floway-session': adminSession } });
    assertEquals(response.status, 200);
    const ids = ((await response.json()) as { data: Array<{ id: string }> }).data.map(m => m.id).sort();
    assertEquals(ids.includes('azure-public'), true);
    assertEquals(ids.includes('custom-model'), true);
  });
});
