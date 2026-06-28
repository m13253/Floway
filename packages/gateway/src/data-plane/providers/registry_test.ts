import { describe, expect, test } from 'vitest';

import { enumerateProviderCandidates } from './candidates.ts';
import { clearInFlightForTesting } from './models-cache.ts';
import { compareModelIds, enumerateModelInterpretations, getModels, listModelProviders, resolveModelForProvider } from './registry.ts';
import { buildCopilotUpstreamRecord, buildCustomUpstreamRecord, copilotModels, setupAppTest } from '../../test-helpers.ts';
import { directFetcher, type Provider } from '@floway-dev/provider';
import { assertEquals, jsonResponse, stubProvider, withMockedFetch } from '@floway-dev/test-utils';

const sortedIds = (ids: readonly string[]): string[] => [...ids].sort(compareModelIds);

// Drains the background revalidate promise so its rejection surfaces in the
// test runner instead of being swallowed.
const testScheduler = (promise: Promise<unknown>): void => {
  promise.catch(err => console.error('[background]', err));
};

test('compareModelIds pushes ids containing "/" to the tail', () => {
  assertEquals(sortedIds(['accounts/msft/x', 'gpt-4o', 'accounts/msft/y', 'claude-opus-4-7']), [
    'claude-opus-4-7',
    'gpt-4o',
    // Within the slashed group, the remaining keys still apply: same alpha
    // prefix "accounts", empty isolated-digit arrays, then descending lex.
    'accounts/msft/y',
    'accounts/msft/x',
  ]);
});

test('compareModelIds groups by leading [a-zA-Z]+ prefix, case-insensitive ascending', () => {
  // gpt and GPT collapse on key 1; their tied [4] digit array falls to
  // descending lex (lowercased), so 'gpt-4o-mini' beats 'gpt-4o'.
  assertEquals(sortedIds(['gpt-4o', 'claude-haiku-4-5', 'deepseek-v4-pro', 'GPT-4o-mini']), [
    'claude-haiku-4-5',
    'deepseek-v4-pro',
    'GPT-4o-mini',
    'gpt-4o',
  ]);
});

test('compareModelIds orders isolated single digits descending element by element', () => {
  // Digit arrays: claude-opus-4-7 [4,7], claude-sonnet-4-6 [4,6],
  // claude-opus-4-5 / claude-haiku-4-5 [4,5]. Within the [4,5] tie, lex
  // descending picks 'claude-opus-4-5' over 'claude-haiku-4-5'.
  assertEquals(sortedIds(['claude-opus-4-7', 'claude-opus-4-5', 'claude-haiku-4-5', 'claude-sonnet-4-6']), [
    'claude-opus-4-7',
    'claude-sonnet-4-6',
    'claude-opus-4-5',
    'claude-haiku-4-5',
  ]);
});

test('compareModelIds puts longer digit arrays before shorter ones (descending)', () => {
  // [5,5] beats every [4]; within the tied-[4] group, descending lex on the
  // full id puts 'gpt-4o' first, then 'gpt-4-turbo', then 'gpt-4' last.
  assertEquals(sortedIds(['gpt-5.5', 'gpt-4', 'gpt-4o', 'gpt-4-turbo']), [
    'gpt-5.5',
    'gpt-4o',
    'gpt-4-turbo',
    'gpt-4',
  ]);
});

test('compareModelIds ignores multi-digit runs such as dates', () => {
  // Both have digit array [4, 7]; descending lex tie-break puts the longer
  // dated id first.
  assertEquals(sortedIds(['claude-opus-4-7-20300101', 'claude-opus-4-7']), [
    'claude-opus-4-7-20300101',
    'claude-opus-4-7',
  ]);
});

test('compareModelIds sorts ids without a leading alpha prefix first', () => {
  assertEquals(sortedIds(['gpt-4o', 'o1-mini', '128k-context-model']), [
    '128k-context-model',
    'gpt-4o',
    'o1-mini',
  ]);
});

test('compareModelIds keeps case-only differences adjacent via lowercase tie-break', () => {
  // All lowercase to 'gpt-4o' so case-folded lex ties; raw descending then
  // picks lowercase letters before uppercase (g > G in ASCII).
  assertEquals(sortedIds(['GPT-4o', 'gpt-4o', 'gpt-4O']), [
    'gpt-4o',
    'gpt-4O',
    'GPT-4o',
  ]);
});

test('listModelProviders creates enabled provider instances with upstream row ids', async () => {
  const { githubAccount, repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_custom', sortOrder: 1 }));
  await repo.upstreams.save({
    id: 'up_azure',
    kind: 'azure',
    name: 'Azure Resource',
    enabled: true,
    sortOrder: 2,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        {
          upstreamModelId: 'gpt-prod',
          endpoints: { chatCompletions: {} },
        },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: [],
    proxyFallbackList: [],
    modelPrefix: null,
    state: null,
  });
  await repo.upstreams.save(buildCopilotUpstreamRecord(githubAccount, { id: 'up_copilot', name: 'Copilot Row', sortOrder: 3 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 0 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(provider => provider.upstream), ['up_custom', 'up_azure', 'up_copilot']);
});

test('getModels returns the merged catalog plus the per-id upstream index', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(buildCustomUpstreamRecord());
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_disabled', enabled: false, sortOrder: 50 }));

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
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(
          copilotModels([
            {
              id: 'shared-model',
              display_name: 'Shared Model',
              supported_endpoints: ['/v1/messages'],
            },
          ]),
        );
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            {
              id: 'shared-model',
              supported_endpoints: ['/chat/completions'],
            },
          ],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const { models, upstreamsByPublicId } = await getModels(null, () => directFetcher, testScheduler);
      const model = models.find(candidate => candidate.id === 'shared-model');

      assertEquals(model?.display_name, 'Shared Model');
      // The merged endpoint surface is the OR of both upstreams' endpoint maps.
      assertEquals(model?.endpoints, { messages: {}, chatCompletions: {} });
      assertEquals(model?.kind, 'chat');
      // `providerData` (the per-provider wire id carrier) belongs to the
      // upstream-facing UpstreamModel, not the gateway-merged catalog row.
      assertEquals(Object.hasOwn(model!, 'providerData'), false);
      // The reverse index lists every upstream that surfaced this id, in
      // enumeration order — copilot first, then custom.
      assertEquals(upstreamsByPublicId.get('shared-model')?.map(p => p.upstream), ['up_copilot', 'up_custom']);

      const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'shared-model', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
      assertEquals(resolved.candidates.map(m => m.provider.upstream), ['up_copilot', 'up_custom']);
      // Each match carries its own per-provider endpoints — no merge.
      assertEquals(resolved.candidates[0]?.model.endpoints, { messages: {} });
      assertEquals(resolved.candidates[1]?.model.endpoints, { chatCompletions: {} });
    },
  );
});

test('enumerateProviderCandidates strips an -YYYYMMDD suffix when nothing matched and retries across every visible upstream', async () => {
  const { repo } = await setupAppTest();

  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

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
      if (url.hostname === 'api.individual.githubcopilot.com' && url.pathname === '/models') {
        return jsonResponse(copilotModels([{ id: 'claude-opus-4.7', supported_endpoints: ['/v1/messages'] }]));
      }
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [{ id: 'claude-opus-4-7' }],
        });
      }

      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'claude-opus-4-7-20300101', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });

      // No upstream's catalog literally lists `claude-opus-4-7-20300101`,
      // so the resolver retries against the stripped `claude-opus-4-7`,
      // which both upstreams expose. Both candidates end up in the
      // result list in configured `sort_order`.
      assertEquals(resolved.candidates.map(m => m.provider.upstream).sort(), ['up_copilot', 'up_custom'].sort());
      assertEquals(resolved.candidates.map(m => m.model.id), ['claude-opus-4-7', 'claude-opus-4-7']);
    },
  );
});

test('enumerateProviderCandidates does not retry when the inbound id has no dated suffix', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'claude-opus-4-7' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      // Plain typo / unknown id — no dated suffix, no retry.
      const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'claude-opus-4-7-unknown', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
      assertEquals(resolved.candidates.length, 0);
    },
  );
});

test('enumerateProviderCandidates prefers the literal dated id over the stripped base when the catalog lists both', async () => {
  // The dated suffix fallback is a SECOND attempt, gated on the first
  // attempt finding nothing. When the upstream catalog already lists the
  // dated id verbatim, the first attempt wins and the stripped form
  // never enters the candidate list.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(
    buildCustomUpstreamRecord({
      config: {
        baseUrl: 'https://custom.example.com',
        authStyle: 'bearer',
        apiKey: 'sk-custom',
        endpoints: { messages: {} },
      },
    }),
  );

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'custom.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({
          object: 'list',
          data: [
            { id: 'claude-sonnet-4-5' },
            { id: 'claude-sonnet-4-5-20251101' },
          ],
        });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'claude-sonnet-4-5-20251101', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
      assertEquals(resolved.candidates.length, 1);
      assertEquals(resolved.candidates[0]?.model.id, 'claude-sonnet-4-5-20251101');
    },
  );
});

test('resolveModelForProvider only loads the selected provider catalog', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_first',
    name: 'First',
    sortOrder: 0,
    config: { baseUrl: 'https://first.example.com', authStyle: 'bearer', apiKey: 'sk-first', endpoints: { responses: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_second',
    name: 'Second',
    sortOrder: 100,
    config: { baseUrl: 'https://second.example.com', authStyle: 'bearer', apiKey: 'sk-second', endpoints: { responses: {} } },
  }));

  const providers = await listModelProviders(null);
  let secondModelsFetches = 0;

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'first.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      if (url.hostname === 'second.example.com' && url.pathname === '/v1/models') {
        secondModelsFetches++;
        return jsonResponse({ data: [{ id: 'target-model' }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolved = await resolveModelForProvider(providers[0], 'target-model', directFetcher, testScheduler);

      assertEquals(resolved?.model.id, 'target-model');
      assertEquals(resolved?.provider.upstream, 'up_first');
    },
  );

  assertEquals(secondModelsFetches, 0);
});

test('listModelProviders without a filter returns global sort_order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(null);
  assertEquals(providers.map(p => p.upstream), ['up_a', 'up_b', 'up_c']);
});

test('listModelProviders honors a per-key whitelist with custom order', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_c', name: 'C', sortOrder: 30 }));

  const providers = await listModelProviders(['up_c', 'up_a']);
  assertEquals(providers.map(p => p.upstream), ['up_c', 'up_a']);
});

test('disabledPublicModelIds hides models from the catalog and routing, per upstream', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const azureUpstream = (over: { id: string; sortOrder: number; models: { upstreamModelId: string; publicModelId?: string }[]; disabledPublicModelIds: string[] }) => ({
    id: over.id,
    kind: 'azure' as const,
    name: over.id,
    enabled: true,
    sortOrder: over.sortOrder,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: over.models.map(m => ({ ...m, endpoints: { chatCompletions: {} } })),
    },
    state: null,
    flagOverrides: {},
    disabledPublicModelIds: over.disabledPublicModelIds,
    proxyFallbackList: [],
    modelPrefix: null,
  });

  // up_a disables a solo model and a shared one (by public id, including a
  // publicModelId override); up_b still serves the shared id, enabled.
  await repo.upstreams.save(azureUpstream({
    id: 'up_a',
    sortOrder: 1,
    models: [
      { upstreamModelId: 'gpt-keep' },
      { upstreamModelId: 'gpt-solo' },
      { upstreamModelId: 'gpt-shared' },
      { upstreamModelId: 'dep-x', publicModelId: 'gpt-override' },
    ],
    disabledPublicModelIds: ['gpt-solo', 'gpt-shared', 'gpt-override'],
  }));
  await repo.upstreams.save(azureUpstream({
    id: 'up_b',
    sortOrder: 2,
    models: [{ upstreamModelId: 'gpt-shared' }],
    disabledPublicModelIds: [],
  }));

  const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
  assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-keep', 'gpt-shared']);

  // The solo and override ids resolve to nothing (hidden + unroutable).
  assertEquals((await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-solo', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' })).candidates.length, 0);
  assertEquals((await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-override', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' })).candidates.length, 0);

  // The shared id survives because up_b allows it; only up_b binds it.
  const shared = await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-shared', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
  assertEquals(shared.candidates.map(m => m.provider.upstream), ['up_b']);

  // The untouched model still routes from up_a.
  const keep = await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-keep', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
  assertEquals(keep.candidates.map(m => m.provider.upstream), ['up_a']);
});

test('resolveModelForProvider rejects a model id disabled on that upstream (filter parity with the catalog)', async () => {
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save({
    id: 'up_x',
    kind: 'azure',
    name: 'X',
    enabled: true,
    sortOrder: 1,
    createdAt: '2026-05-21T00:00:00.000Z',
    updatedAt: '2026-05-21T00:00:00.000Z',
    config: {
      endpoint: 'https://example.openai.azure.com',
      apiKey: 'az-key',
      models: [
        { upstreamModelId: 'enabled-model', endpoints: { chatCompletions: {} } },
        { upstreamModelId: 'disabled-model', endpoints: { chatCompletions: {} } },
      ],
    },
    flagOverrides: {},
    disabledPublicModelIds: ['disabled-model'],
    proxyFallbackList: [],
    modelPrefix: null,
    state: null,
  });

  const [provider] = await listModelProviders(null);
  assertEquals(await resolveModelForProvider(provider, 'enabled-model', directFetcher, testScheduler).then(r => r?.id), 'enabled-model');
  assertEquals(await resolveModelForProvider(provider, 'disabled-model', directFetcher, testScheduler).then(r => r?.id), undefined);
});

test('listModelProviders silently drops disabled upstreams from a whitelist', async () => {
  // A per-user cap legitimately references an upstream the operator just
  // disabled; the cap survives that transition without surfacing an error.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_b', name: 'B', sortOrder: 20, enabled: false }));

  const providers = await listModelProviders(['up_b', 'up_a']);
  assertEquals(providers.map(p => p.upstream), ['up_a']);
});

test('listModelProviders throws on unknown upstream ids in the whitelist', async () => {
  // Unknown ids are a caller-side configuration error, not a runtime state;
  // surface them instead of silently serving a smaller subset.
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();
  await repo.upstreams.save(buildCustomUpstreamRecord({ id: 'up_a', name: 'A', sortOrder: 10 }));

  await expect(listModelProviders(['up_ghost', 'up_a'])).rejects.toThrow(/up_ghost/);
});

// Per-upstream catalog fetches fan out in parallel: total wall-clock time
// tracks the slowest upstream, not the sum. The bound is loose because CI
// timer noise eats into a tight `< sum` comparison; what matters is the
// ratio.
test('getModels fans out per-upstream catalog fetches in parallel', async () => {
  clearInFlightForTesting();
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  const FETCH_DELAY_MS = 60;
  const upstreams = [
    { id: 'up_p1', host: 'p1.example.com', model: 'p1-model' },
    { id: 'up_p2', host: 'p2.example.com', model: 'p2-model' },
    { id: 'up_p3', host: 'p3.example.com', model: 'p3-model' },
  ];
  for (const [index, u] of upstreams.entries()) {
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: u.id,
      name: u.id,
      sortOrder: index,
      config: { baseUrl: `https://${u.host}`, authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));
  }

  await withMockedFetch(
    async request => {
      const url = new URL(request.url);
      const match = upstreams.find(u => url.hostname === u.host);
      if (match && url.pathname === '/v1/models') {
        await new Promise(resolve => setTimeout(resolve, FETCH_DELAY_MS));
        return jsonResponse({ object: 'list', data: [{ id: match.model, supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const start = Date.now();
      const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
      const elapsed = Date.now() - start;

      assertEquals([...catalog.map(m => m.id)].sort(), ['p1-model', 'p2-model', 'p3-model']);
      // A serial walk would take >= 3 * FETCH_DELAY_MS; parallel is bounded by
      // ~FETCH_DELAY_MS plus per-test overhead. Half the serial budget is the
      // loosest threshold that still excludes any serial regression.
      const serialBudget = upstreams.length * FETCH_DELAY_MS;
      if (elapsed >= serialBudget / 2) {
        throw new Error(`expected parallel walk (~${FETCH_DELAY_MS}ms) but took ${elapsed}ms (serial would be ${serialBudget}ms)`);
      }
    },
  );
});

// A single upstream's catalog fetch failure is surfaced as `lastError` and
// recorded against `sawSuccess === true`; the public catalog still includes
// every successful upstream's models.
test('getModels: a rejected provider does not block other providers', async () => {
  clearInFlightForTesting();
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok_1',
    name: 'OK 1',
    sortOrder: 1,
    config: { baseUrl: 'https://ok1.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken',
    sortOrder: 2,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok_2',
    name: 'OK 2',
    sortOrder: 3,
    config: { baseUrl: 'https://ok2.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'ok1.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-1-model', supported_endpoints: ['/chat/completions'] }] });
      }
      if (url.hostname === 'ok2.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-2-model', supported_endpoints: ['/chat/completions'] }] });
      }
      if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'upstream went down' }, 502);
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
      assertEquals([...catalog.map(m => m.id)].sort(), ['ok-1-model', 'ok-2-model']);
    },
  );
});

// Regression: when an upstream's force re-fetch rejects past HARD, the call
// site asking for a model belonging to one of the *healthy* upstreams must
// still resolve. The broken upstream's display name flows back via
// `failedUpstreams` so the eventual error renderer can mention it.
test('enumerateProviderCandidates: healthy upstream still resolves alongside a rejecting one, with failedUpstreams reported', async () => {
  clearInFlightForTesting();
  const { repo } = await setupAppTest();
  await repo.upstreams.deleteAll();

  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_broken',
    name: 'Broken upstream',
    sortOrder: 1,
    config: { baseUrl: 'https://broken.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));
  await repo.upstreams.save(buildCustomUpstreamRecord({
    id: 'up_ok',
    name: 'Healthy upstream',
    sortOrder: 2,
    config: { baseUrl: 'https://ok.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
  }));

  await withMockedFetch(
    request => {
      const url = new URL(request.url);
      if (url.hostname === 'broken.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ error: 'upstream went down' }, 502);
      }
      if (url.hostname === 'ok.example.com' && url.pathname === '/v1/models') {
        return jsonResponse({ object: 'list', data: [{ id: 'ok-model', supported_endpoints: ['/chat/completions'] }] });
      }
      throw new Error(`Unhandled fetch ${request.url}`);
    },
    async () => {
      const resolvedExisting = await enumerateProviderCandidates({ upstreamIds: null, model: 'ok-model', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
      assertEquals(resolvedExisting.candidates.map(m => m.provider.upstream), ['up_ok']);
      assertEquals(resolvedExisting.candidates[0]?.model.id, 'ok-model');
      assertEquals(resolvedExisting.failedUpstreams, ['Broken upstream']);

      // A model nobody currently knows about must NOT rethrow the broken
      // upstream's catalog error — the caller's failure renderer is the right
      // place to surface that, parenthetically, alongside the model-missing
      // body.
      const resolvedMissing = await enumerateProviderCandidates({ upstreamIds: null, model: 'unknown-model', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
      assertEquals(resolvedMissing.candidates.length, 0);
      assertEquals(resolvedMissing.failedUpstreams, ['Broken upstream']);
    },
  );
});

const fakeProvider = (over: Partial<Provider>): Provider => ({
  upstream: 'u',
  providerKind: 'custom',
  name: 'fake',
  disabledPublicModelIds: [],
  modelPrefix: null,
  instance: stubProvider(),
  supportsResponsesItemReference: false,
  ...over,
});

describe('enumerateModelInterpretations', () => {
  const A = fakeProvider({ upstream: 'A', name: 'a', modelPrefix: null });
  const B = fakeProvider({
    upstream: 'B', name: 'b',
    modelPrefix: { prefix: 'or/', addressable: ['prefixed'], listed: ['prefixed'] },
  });
  const C = fakeProvider({
    upstream: 'C', name: 'c',
    modelPrefix: { prefix: 'cx/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
  });

  // Project each interpretation to (upstream, lookupId) for a compact
  // structural assertion.
  const shape = (out: readonly { provider: Provider; lookupId: string }[]) =>
    out.map(({ provider, lookupId }) => ({ upstream: provider.upstream, lookupId }));

  test('bare-id request enumerates only upstreams that accept the bare form', () => {
    // A: no prefix, bare always accepted. B: prefixed-only addressable — bare
    // is not accepted. C: dual-addressable, bare accepted; the prefixed form
    // does not apply because `gpt-4o` does not start with `cx/`.
    assertEquals(shape(enumerateModelInterpretations('gpt-4o', [A, B, C])), [
      { upstream: 'A', lookupId: 'gpt-4o' },
      { upstream: 'C', lookupId: 'gpt-4o' },
    ]);
  });

  test('prefix-only-addressable upstream strips the prefix when it matches', () => {
    assertEquals(shape(enumerateModelInterpretations('or/gpt-4o', [B])), [
      { upstream: 'B', lookupId: 'gpt-4o' },
    ]);
  });

  test('prefix-only-addressable upstream is silent when the prefix does not match', () => {
    assertEquals(enumerateModelInterpretations('gpt-4o', [B]), []);
  });

  test('dual-addressable upstream produces two interpretations when the prefix matches', () => {
    // FORM_ORDER puts unprefixed before prefixed: the bare lookupId (which
    // happens to be the literal inbound id) is enumerated first, then the
    // prefix-stripped one.
    const D = fakeProvider({
      upstream: 'D', name: 'd',
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    });
    assertEquals(shape(enumerateModelInterpretations('or/gpt-4o', [D])), [
      { upstream: 'D', lookupId: 'or/gpt-4o' },
      { upstream: 'D', lookupId: 'gpt-4o' },
    ]);
  });

  test('three upstreams advertising the same public id via different paths all enumerate', () => {
    // X strips its `aa/` prefix and asks its catalog for `bb/gpt-5`. Y strips
    // its longer `aa/bb/` prefix and asks for `gpt-5`. Z accepts the literal
    // inbound id as a bare catalog lookup. Three distinct (provider, lookup)
    // pairs survive; nothing shadows anything else.
    const X = fakeProvider({
      upstream: 'X', name: 'x',
      modelPrefix: { prefix: 'aa/', addressable: ['prefixed'], listed: ['prefixed'] },
    });
    const Y = fakeProvider({
      upstream: 'Y', name: 'y',
      modelPrefix: { prefix: 'aa/bb/', addressable: ['prefixed'], listed: ['prefixed'] },
    });
    const Z = fakeProvider({ upstream: 'Z', name: 'z', modelPrefix: null });
    assertEquals(shape(enumerateModelInterpretations('aa/bb/gpt-5', [X, Y, Z])), [
      { upstream: 'X', lookupId: 'bb/gpt-5' },
      { upstream: 'Y', lookupId: 'gpt-5' },
      { upstream: 'Z', lookupId: 'aa/bb/gpt-5' },
    ]);
  });
});

// End-to-end listing checks for the prefix policy. The catalog walk goes
// through getModels, which threads custom upstreams' /v1/models
// responses through fetchUpstreamModelsCached just like production does.
describe('catalog listing under modelPrefix', () => {
  test('null prefix lists bare ids only (today\'s behavior)', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_plain',
      sortOrder: 1,
      config: { baseUrl: 'https://plain.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'plain.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['gpt-4o']);
      },
    );
  });

  test('listed=[prefixed] lists only the prefixed surface and routes the prefixed request to the upstream', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_prefixed',
      sortOrder: 1,
      config: { baseUrl: 'https://prefixed.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'prefixed.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);
        // Prefixed surface gets a synthesized display_name prepending the
        // upstream's display name so the dashboard tells the operator at a
        // glance which upstream a prefixed entry came from.
        assertEquals(catalog[0]?.display_name, 'Custom Provider: gpt-4o');

        // Regression: with `listed: ['prefixed']` the catalog walk emits only
        // the prefixed surface, so a byId-based routing lookup against the
        // stripped bare id would miss. Routing must instead consult each
        // scoped upstream's own catalog, where the bare id is always present.
        const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.provider.upstream), ['up_prefixed']);
        assertEquals(resolved.candidates[0]?.model.id, 'gpt-4o');

        // The bare-id request must NOT route to a prefix-only-addressable
        // upstream, regardless of routing path.
        const bare = await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(bare.candidates.length, 0);
      },
    );
  });

  test('addressable=[unprefixed, prefixed] + listed=[prefixed] routes both surface forms', async () => {
    // The upstream is bare-id-addressable but only the prefixed form appears
    // in /v1/models. Routing must still resolve a bare-id request via the
    // upstream's own catalog (addressable=['unprefixed', 'prefixed'] keeps it
    // in the candidate set), and a prefixed request via the prefix-strip +
    // per-provider catalog lookup.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual_addressable',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
        assertEquals(catalog.map(m => m.id), ['or/gpt-4o']);

        const bare = await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(bare.candidates.map(m => m.provider.upstream), ['up_dual_addressable']);
        assertEquals(bare.candidates[0]?.model.id, 'gpt-4o');

        // The prefixed request enumerates both forms against `up_dual_addressable`:
        // the unprefixed lookup (`or/gpt-4o`) misses the upstream catalog, and
        // the prefix-stripped lookup (`gpt-4o`) hits — yielding a single match.
        const prefixed = await enumerateProviderCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(prefixed.candidates.map(m => m.provider.upstream), ['up_dual_addressable']);
        assertEquals(prefixed.candidates[0]?.model.id, 'gpt-4o');
      },
    );
  });

  test('listed=[unprefixed, prefixed] emits both surfaces, both upstreams enumerate on the shared bare id', async () => {
    // up_plain has no prefix and lists `gpt-4o`. up_dual exposes both forms.
    // The bare `gpt-4o` reaches both upstreams (no first-wins exclusion); the
    // `or/gpt-4o` surface belongs solely to up_dual because up_plain's catalog
    // does not contain `or/gpt-4o`.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_plain',
      sortOrder: 1,
      config: { baseUrl: 'https://plain.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual',
      sortOrder: 2,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'plain.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-4o', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
        assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-4o', 'or/gpt-4o']);

        // Both upstreams enumerate against the bare id: up_plain via its only
        // form, up_dual via the unprefixed interpretation. Order follows the
        // configured sort_order across providers, then FORM_ORDER within one.
        const bare = await enumerateProviderCandidates({ upstreamIds: null, model: 'gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(bare.candidates.map(m => m.provider.upstream), ['up_plain', 'up_dual']);

        // The prefixed id resolves only against up_dual: up_plain's catalog
        // does not contain `or/gpt-4o`, and up_dual's prefix-stripped lookup
        // hits its catalog's bare `gpt-4o`.
        const prefixed = await enumerateProviderCandidates({ upstreamIds: null, model: 'or/gpt-4o', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(prefixed.candidates.map(m => m.provider.upstream), ['up_dual']);
      },
    );
  });

  test('disabledPublicModelIds hides both bare and prefixed forms from the originating upstream', async () => {
    // up_dual exposes `gpt-4o` and `gpt-mini` under both forms, but the
    // operator disabled `gpt-4o` on this upstream. Neither `gpt-4o` nor
    // `or/gpt-4o` survives from up_dual; `gpt-mini` and `or/gpt-mini` stay.
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_dual',
      sortOrder: 1,
      config: { baseUrl: 'https://dual.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'or/', addressable: ['unprefixed', 'prefixed'], listed: ['unprefixed', 'prefixed'] },
      disabledPublicModelIds: ['gpt-4o'],
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'dual.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({
            object: 'list',
            data: [
              { id: 'gpt-4o', supported_endpoints: ['/chat/completions'] },
              { id: 'gpt-mini', supported_endpoints: ['/chat/completions'] },
            ],
          });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const catalog = (await getModels(null, () => directFetcher, testScheduler)).models;
        assertEquals([...catalog.map(m => m.id)].sort(), ['gpt-mini', 'or/gpt-mini']);
      },
    );
  });

  // Regression for the three-upstream case the routing-primitive refactor was
  // motivated by. The same public id `aa/bb/gpt-5` is reachable through three
  // configured paths: an `aa/`-prefixed upstream whose catalog carries the id
  // `bb/gpt-5`, a longer `aa/bb/`-prefixed upstream whose catalog carries the
  // id `gpt-5`, and a bare upstream whose catalog literally carries
  // `aa/bb/gpt-5`. Every upstream must enumerate as an independent match —
  // the old first-wins primitive would have shadowed two of them.
  test('three upstreams advertising the same public id via different paths all enumerate as matches', async () => {
    const { repo } = await setupAppTest();
    await repo.upstreams.deleteAll();
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_short_prefix',
      sortOrder: 1,
      config: { baseUrl: 'https://short.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'aa/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_long_prefix',
      sortOrder: 2,
      config: { baseUrl: 'https://long.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
      modelPrefix: { prefix: 'aa/bb/', addressable: ['prefixed'], listed: ['prefixed'] },
    }));
    await repo.upstreams.save(buildCustomUpstreamRecord({
      id: 'up_bare',
      sortOrder: 3,
      config: { baseUrl: 'https://bare.example.com', authStyle: 'bearer', apiKey: 'sk-x', endpoints: { chatCompletions: {} } },
    }));

    await withMockedFetch(
      request => {
        const url = new URL(request.url);
        if (url.hostname === 'short.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'bb/gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'long.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        if (url.hostname === 'bare.example.com' && url.pathname === '/v1/models') {
          return jsonResponse({ object: 'list', data: [{ id: 'aa/bb/gpt-5', supported_endpoints: ['/chat/completions'] }] });
        }
        throw new Error(`Unhandled fetch ${request.url}`);
      },
      async () => {
        const resolved = await enumerateProviderCandidates({ upstreamIds: null, model: 'aa/bb/gpt-5', kind: 'chat', scheduler: testScheduler, currentColo: 'TEST' });
        assertEquals(resolved.candidates.map(m => m.provider.upstream), ['up_short_prefix', 'up_long_prefix', 'up_bare']);
        assertEquals(resolved.candidates.map(m => m.model.id), ['bb/gpt-5', 'gpt-5', 'aa/bb/gpt-5']);
      },
    );
  });
});
