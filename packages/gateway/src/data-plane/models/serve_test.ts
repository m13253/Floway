import { test } from 'vitest';

import type { MemoryModelAliasesRepo } from '../../repo/memory.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, requestApp, setupAppTest } from '../../test-helpers.ts';
import { clearInProcessCopilotTokenCache } from '@floway-dev/provider-copilot';
import { jsonResponse, withMockedFetch, assertEquals } from '@floway-dev/test-utils';

const SECOND_ACCOUNT = {
  token: 'ghu_second',
  user: {
    id: 2002,
    login: 'second',
    name: 'Second Account',
    avatar_url: 'https://example.com/second.png',
  },
};

test('/v1/models returns merged model list from Copilot and custom upstreams', async () => {
  const { repo, apiKey } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-test',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-sonnet-4',
              display_name: 'Claude Sonnet 4',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'gpt-4o' }, { id: 'gpt-4o-mini' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as {
        object: string;
        data: Array<{
          id: string;
          object?: string;
          type?: string;
          display_name?: string;
          kind?: 'chat' | 'embedding' | 'image';
          limits?: Record<string, number>;
          capabilities?: unknown;
          provider?: unknown;
          providerKind?: unknown;
          providers?: unknown;
          providerData?: unknown;
          endpoints?: unknown;
          upstream?: unknown;
          upstreamModel?: unknown;
          name?: unknown;
          version?: unknown;
          billing?: unknown;
          policy?: unknown;
          model_picker_enabled?: unknown;
          description?: unknown;
          owned_by?: unknown;
        }>;
      };
      assertEquals(body.object, 'list');

      const ids = body.data.map(m => m.id);
      assertEquals(ids.includes('claude-sonnet-4'), true);
      assertEquals(ids.includes('gpt-4o'), true);
      assertEquals(ids.includes('gpt-4o-mini'), true);

      const claude = body.data.find(m => m.id === 'claude-sonnet-4')!;
      // Superset DTO: OpenAI's object + Anthropic's type + Anthropic's display_name
      // + our extras. Slim ModelMetadata fields only.
      assertEquals(claude.object, 'model');
      assertEquals(claude.type, 'model');
      assertEquals(claude.display_name, 'Claude Sonnet 4');
      assertEquals(claude.kind, 'chat');
      assertEquals(claude.limits, {});
      assertEquals(claude.capabilities, undefined);

      for (const model of body.data) {
        // Provider / upstream identity is hidden on the public surface.
        assertEquals(model.provider, undefined);
        assertEquals(model.providerKind, undefined);
        assertEquals(model.providers, undefined);
        assertEquals(model.providerData, undefined);
        assertEquals(model.endpoints, undefined);
        assertEquals(model.upstream, undefined);
        assertEquals(model.upstreamModel, undefined);
        // Copilot-only raw fields never reach the public DTO.
        assertEquals(model.name, undefined);
        assertEquals(model.version, undefined);
        assertEquals(model.billing, undefined);
        assertEquals(model.policy, undefined);
        assertEquals(model.model_picker_enabled, undefined);
        assertEquals(model.description, undefined);
      }

      const anthropicResponse = await requestApp('/models', {
        headers: { 'x-api-key': apiKey.key },
      });
      assertEquals(anthropicResponse.status, 200);
      assertEquals(await anthropicResponse.json(), body);

      // Dashboard adds two UI-only fields on top of the public DTO.
      const controlResponse = await requestApp('/api/models', {
        headers: { 'x-api-key': apiKey.key },
      });
      assertEquals(controlResponse.status, 200);
      const controlBody = (await controlResponse.json()) as {
        data: Array<{
          id: string;
          display_name: string;
          upstreams?: Array<{ kind: 'copilot' | 'custom' | 'azure'; id: string; name: string }>;
          provider?: unknown;
          upstream_ids?: unknown;
          billing?: unknown;
          policy?: unknown;
          model_picker_enabled?: unknown;
          name?: unknown;
          version?: unknown;
          supported_endpoints?: unknown;
          description?: unknown;
        }>;
      };
      const controlClaude = controlBody.data.find(m => m.id === 'claude-sonnet-4')!;
      assertEquals(controlClaude.display_name, 'Claude Sonnet 4');
      assertEquals(controlClaude.upstreams, [{ kind: 'copilot', id: 'up_copilot', name: 'GitHub Copilot (tester)' }]);
      assertEquals(controlBody.data.find(m => m.id === 'gpt-4o')?.upstreams, [{ kind: 'custom', id: 'up_oai', name: 'Test OpenAI' }]);
      // Legacy split fields and Copilot-only fields never reach the dashboard.
      for (const model of controlBody.data) {
        assertEquals(model.provider, undefined);
        assertEquals(model.upstream_ids, undefined);
        assertEquals(model.billing, undefined);
        assertEquals(model.policy, undefined);
        assertEquals(model.model_picker_enabled, undefined);
        assertEquals(model.name, undefined);
        assertEquals(model.version, undefined);
        assertEquals(model.supported_endpoints, undefined);
        assertEquals(model.description, undefined);
      }
    },
  );
});

test('/models returns the same superset payload as /v1/models', async () => {
  const { apiKey, repo } = await setupAppTest();
  // Image-kind projection requires a non-Copilot id like gpt-image-* (matched
  // by the Tier 2 id heuristic) since the Copilot fixture only emits chat and
  // embedding models.
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_images_proj',
    name: 'Image Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://images-proj.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-images-proj',
      endpoints: {  },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(
          copilotModels([
            {
              id: 'claude-opus-4.7-xhigh',
              display_name: 'Claude Opus 4.7 XHigh',
              supported_endpoints: ['/v1/messages'],
            },
            {
              id: 'embedding-only',
              supported_endpoints: ['/embeddings'],
            },
          ]),
        );
      }
      if (url.hostname === 'images-proj.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-image-2' }] });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      assertEquals(await response.json(), {
        object: 'list',
        has_more: false,
        first_id: 'claude-opus-4-7',
        last_id: 'gpt-image-2',
        data: [
          {
            id: 'claude-opus-4-7',
            object: 'model',
            type: 'model',
            display_name: 'Claude Opus 4.7 XHigh',
            limits: {},
            kind: 'chat',
            cost: {
              input: 5,
              output: 25,
              input_cache_read: 0.5,
              input_cache_write: 6.25,
              tiers: {
                fast: {
                  input: 30,
                  output: 150,
                  input_cache_read: 3,
                  input_cache_write: 37.5,
                },
              },
            },
          },
          {
            id: 'embedding-only',
            object: 'model',
            type: 'model',
            display_name: 'embedding-only',
            limits: {},
            kind: 'embedding',
          },
          {
            id: 'gpt-image-2',
            object: 'model',
            type: 'model',
            display_name: 'gpt-image-2',
            limits: {},
            kind: 'image',
          },
        ],
      });
    },
  );
});

test('/v1/models hides upstream identity when a provider returns an invalid model list', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_secret_provider',
    name: 'Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://secret.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-secret',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'secret.example.com') {
        return jsonResponse({ object: 'list', data: null });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 502);
      const body = (await response.json()) as { error: { message: string } };
      assertEquals(body.error.message, 'Upstream model listing failed');
    },
  );
});

test('public model list endpoints hide upstream HTTP error bodies and headers', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_http_secret_provider',
    name: 'HTTP Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://http-secret.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-secret',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'http-secret.example.com') {
        return new Response('secret upstream body: up_http_secret_provider', {
          status: 403,
          headers: {
            'content-type': 'text/plain',
            'x-upstream-id': 'up_http_secret_provider',
          },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 502);
        assertEquals(response.headers.get('x-upstream-id'), null);
        assertEquals(await response.json(), {
          error: {
            message: 'Upstream model listing failed',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('public model list endpoints hide thrown upstream request errors', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_throw_secret_provider',
    name: 'Throw Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://throw-secret.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-secret',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'throw-secret.example.com') {
        throw new Error('network failure contacting https://throw-secret.example.com/v1/models');
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 502);
        assertEquals(await response.json(), {
          error: {
            message: 'Upstream model listing failed',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('public model list endpoints hide malformed upstream response bodies', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_malformed_secret_provider',
    name: 'Malformed Secret Provider',
    sortOrder: 100,
    config: {
      baseUrl: 'https://malformed-secret.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-secret',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'malformed-secret.example.com') {
        return new Response('secret malformed body: up_malformed_secret_provider', {
          status: 200,
          headers: { 'content-type': 'application/json' },
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      for (const path of ['/v1/models', '/models', '/api/models']) {
        const response = await requestApp(path, {
          headers: { 'x-api-key': apiKey.key },
        });
        assertEquals(response.status, 502);
        assertEquals(await response.json(), {
          error: {
            message: 'Upstream model listing failed',
            type: 'api_error',
          },
        });
      }
    },
  );
});

test('/v1/models surfaces the actionable "no upstream configured" hint when no provider is configured', async () => {
  const { repo, apiKey } = await setupAppTest();
  await repo.upstreams.deleteAll();
  clearInProcessCopilotTokenCache();

  const response = await requestApp('/v1/models', {
    headers: { 'x-api-key': apiKey.key },
  });

  assertEquals(response.status, 502);
  assertEquals(await response.json(), {
    error: {
      message: 'No upstream provider configured — connect GitHub Copilot or add a Custom/Azure upstream in the dashboard',
      type: 'api_error',
    },
  });
});

test('/v1/models returns the id-sorted union of every connected GitHub account', async () => {
  const { repo, apiKey, githubAccount } = await setupAppTest();
  await repo.upstreams.save(buildCopilotUpstreamRecord(SECOND_ACCOUNT, { id: 'up_copilot_second', sortOrder: 1 }));

  const tokenForGithubToken = new Map([
    [githubAccount.token, 'copilot-first'],
    [SECOND_ACCOUNT.token, 'copilot-second'],
  ]);

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }

      if (url.pathname === '/copilot_internal/v2/token') {
        const githubToken = request.headers.get('authorization')?.replace('token ', '') ?? '';
        return jsonResponse({
          token: tokenForGithubToken.get(githubToken),
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }

      if (url.pathname === '/models') {
        const auth = request.headers.get('authorization');
        if (auth === 'Bearer copilot-first') {
          return jsonResponse(
            copilotModels([
              { id: 'shared-model', supported_endpoints: ['/v1/messages'] },
              { id: 'first-only', supported_endpoints: ['/responses'] },
            ]),
          );
        }

        if (auth === 'Bearer copilot-second') {
          return jsonResponse(
            copilotModels([
              { id: 'shared-model', supported_endpoints: ['/chat/completions'] },
              { id: 'second-only', supported_endpoints: ['/v1/messages'] },
            ]),
          );
        }
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      assertEquals(response.status, 200);
      const body = (await response.json()) as {
        data: Array<{
          id: string;
          supported_endpoints?: string[];
          provider?: string;
        }>;
      };
      assertEquals(
        body.data.map(model => model.id),
        ['first-only', 'second-only', 'shared-model'],
      );
      assertEquals(body.data[0].supported_endpoints, undefined);
      assertEquals(body.data[0].provider, undefined);
    },
  );
});

test('/v1/models returns the last real error when every account model load fails', async () => {
  const { apiKey } = await setupAppTest();

  await withMockedFetch(
    request => {
      const url = new URL(request.url);

      if (url.hostname === 'update.code.visualstudio.com') {
        return jsonResponse(['1.110.1']);
      }

      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-invalid-models',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }

      if (url.pathname === '/models') {
        return jsonResponse({ object: 'unexpected', data: [] });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', {
        headers: { 'x-api-key': apiKey.key },
      });

      // Unexpected `object` value is intentionally non-fatal — the handler
      // only iterates `data`.
      assertEquals(response.status, 200);
      const body = (await response.json()) as { data: unknown[] };
      assertEquals(body.data, []);
    },
  );
});

// /v1/models alias-listing coverage. Each test exercises one slice of the
// spec's visibility contract: visible alias appears with `aliasedFrom`,
// hidden alias does not appear, alias-with-disabled-target is still listed,
// the `aliasedFrom` shape matches the spec byte-for-byte.
test('/v1/models appends a visible alias with aliasedFrom after the real entries', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'codex-auto-review',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: { reasoning: { effort: 'low' } },
      visibleInModelsList: true,
      onConflict: 'real-only',
      createdAt: 1_700_000_000,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-test',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({
          token: 'copilot-access-token',
          expires_at: 4102444800,
          refresh_in: 3600,
          endpoints: { api: 'https://api.individual.githubcopilot.com' },
        });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(copilotModels([]));
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'gpt-5.4', owned_by: 'openai' }],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      assertEquals(response.status, 200);
      const body = await response.json() as { data: Array<{ id: string; owned_by?: string; aliasedFrom?: unknown }> };
      const ids = body.data.map(m => m.id);
      assertEquals(ids[ids.length - 1], 'codex-auto-review');
      const aliasEntry = body.data.find(m => m.id === 'codex-auto-review');
      if (!aliasEntry) throw new Error('expected codex-auto-review alias entry');
      assertEquals(aliasEntry.aliasedFrom, {
        targetModelId: 'gpt-5.4',
        upstreamIds: [],
        rules: { reasoning: { effort: 'low' } },
        onConflict: 'real-only',
      });
      assertEquals(aliasEntry.owned_by, 'openai');
    },
  );
});

test('/v1/models omits aliases marked visibleInModelsList=false', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'hidden-alias',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: {},
      visibleInModelsList: false,
      onConflict: 'real-only',
      createdAt: 0,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-test',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(copilotModels([]));
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string }> };
      assertEquals(body.data.map(m => m.id).includes('hidden-alias'), false);
    },
  );
});

test('/v1/models omits an alias whose target is not in any reachable upstream catalog', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'orphan-alias',
      targetModelId: 'never-resolves',
      upstreamIds: ['up_oai'],
      rules: {},
      visibleInModelsList: true,
      onConflict: 'real-only',
      createdAt: 0,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_oai',
    name: 'Test OpenAI',
    sortOrder: 100,
    config: {
      baseUrl: 'https://oai.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-test',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') {
        return jsonResponse(copilotModels([]));
      }
      if (url.pathname === '/v1/models' && url.hostname === 'oai.example.com') {
        return jsonResponse({ object: 'list', data: [] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string }> };
      // Per-upstream alias enumeration: an alias whose target cannot be served
      // by any reachable upstream produces zero entries — there is no surface
      // form to attach the alias to. A request for `orphan-alias` still
      // returns the canonical user-facing model-missing error.
      assertEquals(body.data.map(m => m.id).includes('orphan-alias'), false);
    },
  );
});

test('/v1/models emits the alias on each reachable upstream + listed form; prefixed entries carry the upstream label, unprefixed entries do not', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'codex-auto-review',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: { reasoning: { effort: 'low' } },
      visibleInModelsList: true,
      onConflict: 'real-only',
      displayName: 'Codex Auto Review',
      createdAt: 1_700_000_000,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_azure',
    name: 'Azure',
    sortOrder: 100,
    config: {
      baseUrl: 'https://azure.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-azure',
      endpoints: { chatCompletions: {} },
    },
    modelPrefix: { prefix: 'azure/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      if (url.pathname === '/v1/models' && url.hostname === 'azure.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4', display_name: 'GPT-5.4' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string; display_name: string; aliasedFrom?: unknown }> };
      // Both addressable forms appear because the upstream listed both.
      const bare = body.data.find(m => m.id === 'codex-auto-review');
      const prefixed = body.data.find(m => m.id === 'azure/codex-auto-review');
      if (!bare || !prefixed) throw new Error('expected both bare and prefixed alias entries');
      assertEquals(bare.display_name, 'Codex Auto Review');
      assertEquals(prefixed.display_name, 'Azure: Codex Auto Review');
    },
  );
});

test('/v1/models falls back to target display_name + rules summary when the alias has no displayName', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'codex-auto-review',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: { reasoning: { effort: 'low' } },
      visibleInModelsList: true,
      onConflict: 'real-only',
      createdAt: 1_700_000_000,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_azure',
    name: 'Azure',
    sortOrder: 100,
    config: {
      baseUrl: 'https://azure.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-azure',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      if (url.pathname === '/v1/models' && url.hostname === 'azure.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4', display_name: 'GPT-5.4' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string; display_name: string }> };
      const entry = body.data.find(m => m.id === 'codex-auto-review');
      if (!entry) throw new Error('expected codex-auto-review alias entry');
      assertEquals(entry.display_name, 'GPT-5.4 (low effort)');
    },
  );
});

test('/v1/models honours alias upstreamIds — only emits on the named upstream', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'codex-auto-review',
      targetModelId: 'gpt-5.4',
      upstreamIds: ['up_azure'],
      rules: {},
      visibleInModelsList: true,
      onConflict: 'real-only',
      createdAt: 1_700_000_000,
    },
  ]);

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_azure',
    name: 'Azure',
    sortOrder: 100,
    config: {
      baseUrl: 'https://azure.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-azure',
      endpoints: { chatCompletions: {} },
    },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_other',
    name: 'Other',
    sortOrder: 200,
    config: {
      baseUrl: 'https://other.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-other',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      // Both upstreams expose gpt-5.4 — but the alias is restricted to up_azure.
      if (url.pathname === '/v1/models' && url.hostname === 'azure.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4' }] });
      }
      if (url.pathname === '/v1/models' && url.hostname === 'other.example.com') {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string; display_name: string }> };
      const aliasRows = body.data.filter(m => m.id === 'codex-auto-review');
      assertEquals(aliasRows.length, 1);
      assertEquals(aliasRows[0].display_name, 'gpt-5.4');
    },
  );
});

test('/v1/models merges alias emissions whose synthesized public id collides — one row, multiple backing upstreams', async () => {
  const { repo, apiKey } = await setupAppTest();

  (repo.modelAliases as MemoryModelAliasesRepo).setAll([
    {
      alias: 'codex-auto-review',
      displayName: 'Codex Auto Review',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: { reasoning: { effort: 'low' } },
      visibleInModelsList: true,
      onConflict: 'real-only',
      createdAt: 1_700_000_000,
    },
  ]);

  // Two no-prefix upstreams both serve gpt-5.4 — without dedupe, the alias
  // would emit two `codex-auto-review` rows. With dedupe, the dashboard sees
  // one row whose `upstreams` field lists both bindings, exactly like real
  // models that exist on multiple upstreams.
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_alpha',
    name: 'Alpha',
    sortOrder: 100,
    config: {
      baseUrl: 'https://alpha.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-alpha',
      endpoints: { chatCompletions: {} },
    },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_beta',
    name: 'Beta',
    sortOrder: 200,
    config: {
      baseUrl: 'https://beta.example.com',
      authStyle: 'bearer',
      apiKey: 'sk-beta',
      endpoints: { chatCompletions: {} },
    },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'update.code.visualstudio.com') return jsonResponse(['1.110.1']);
      if (url.pathname === '/copilot_internal/v2/token') {
        return jsonResponse({ token: 'copilot-access-token', expires_at: 4102444800, refresh_in: 3600, endpoints: { api: 'https://api.individual.githubcopilot.com' } });
      }
      if (url.pathname === '/models' && url.hostname === 'api.individual.githubcopilot.com') return jsonResponse(copilotModels([]));
      if (url.pathname === '/v1/models' && (url.hostname === 'alpha.example.com' || url.hostname === 'beta.example.com')) {
        return jsonResponse({ object: 'list', data: [{ id: 'gpt-5.4' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const response = await requestApp('/v1/models', { headers: { 'x-api-key': apiKey.key } });
      const body = await response.json() as { data: Array<{ id: string }> };
      const rows = body.data.filter(m => m.id === 'codex-auto-review');
      assertEquals(rows.length, 1);
    },
  );
});
