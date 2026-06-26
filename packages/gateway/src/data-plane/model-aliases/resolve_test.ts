// Behavioral coverage for the alias resolver. Mocks `providers/registry.ts`
// + the per-request fetcher so each test can hand-script which target
// model ids look routable; the resolver itself runs unmocked, so its
// filter logic (kind match, availability, selection strategy) is the
// thing under test.

import { test, vi } from 'vitest';

import type { ModelAliasRecord, ModelAliasesRepo } from '../../repo/types.ts';
import { stubAuthedContext } from '../../test-helpers/gateway-ctx.ts';
import type { ModelInterpretation, ProviderModelResolution } from '../providers/registry.ts';
import { directFetcher } from '@floway-dev/provider';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

// Avoid the real `listModelProviders` (which reads the global repo) and the
// real `collectInterpretationOutcomes` (which goes through the per-request
// fetcher cache). The mocks let each test stamp which target_model_ids are
// "routable" right now and which endpoints they expose.
const routableModels = new Map<string, { endpoints: Record<string, unknown> }>();
const ALWAYS_ROUTABLE_ENDPOINTS = { chatCompletions: {}, responses: {}, messages: {} };

vi.mock('../providers/registry.ts', () => ({
  listModelProviders: vi.fn(async () => [{ upstream: 'u_test', name: 'u_test', modelPrefix: null }]),
  enumerateModelInterpretations: vi.fn((modelId: string, providers: readonly { upstream: string }[]): ModelInterpretation[] =>
    providers.map(p => ({ provider: p, lookupId: modelId } as unknown as ModelInterpretation))),
  collectInterpretationOutcomes: vi.fn(async (interpretations: readonly { provider: { upstream: string }; lookupId: string }[]) => ({
    resolutions: interpretations
      .filter(i => routableModels.has(i.lookupId))
      .map(i => ({
        interpretation: i,
        provider: i.provider,
        resolved: {
          id: i.lookupId,
          model: { id: i.lookupId, endpoints: routableModels.get(i.lookupId)!.endpoints },
          binding: { upstream: i.provider.upstream, upstreamModel: { id: i.lookupId, endpoints: routableModels.get(i.lookupId)!.endpoints } },
        } as unknown as ProviderModelResolution,
      })),
    failedUpstreams: [],
  })),
}));

vi.mock('../../dial/per-request.ts', () => ({
  createPerRequestFetcher: vi.fn(async () => () => directFetcher),
}));

const { resolveAlias, AliasNoTargetAvailableError } = await import('./resolve.ts');

const stubRepoFor = (record: ModelAliasRecord | null): ModelAliasesRepo => ({
  list: () => Promise.resolve(record ? [record] : []),
  getByName: name => Promise.resolve(record?.name === name ? structuredClone(record) : null),
  insert: () => Promise.reject(new Error('insert should not be called from resolver tests')),
  update: () => Promise.reject(new Error('update should not be called from resolver tests')),
  delete: () => Promise.resolve(false),
  deleteAll: () => Promise.resolve(),
});

const aliasRecord = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  displayName: null,
  visibleInModelsList: true,
  targets: [{ target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } }],
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

const RESOLVE_DEFAULTS = {
  endpointKind: 'chat' as const,
  upstreamIds: null,
  scheduler: () => {},
  currentColo: 'TEST',
};

const setRoutable = (...ids: string[]): void => {
  routableModels.clear();
  for (const id of ids) routableModels.set(id, { endpoints: ALWAYS_ROUTABLE_ENDPOINTS });
};

// Silence the unused-ctx warning helpers
void stubAuthedContext;

test('returns null when no alias matches the inbound name', async () => {
  setRoutable('gpt-5.4');
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    modelName: 'not-an-alias',
    repo: stubRepoFor(null),
  });
  assertEquals(result, null);
});

test('returns the target and rules when kind matches and a single target is available', async () => {
  setRoutable('gpt-5.4');
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    modelName: 'gpt-fast',
    repo: stubRepoFor(aliasRecord()),
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'gpt-5.4');
  assertEquals(result.aliasName, 'gpt-fast');
  assertEquals(result.rules, { reasoning: { effort: 'low' } });
});

test('returns null when the alias kind does not match the inbound endpoint group', async () => {
  setRoutable('gpt-5.4');
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    endpointKind: 'embedding',
    modelName: 'gpt-fast',
    repo: stubRepoFor(aliasRecord()),
  });
  assertEquals(result, null);
});

test('throws AliasNoTargetAvailableError when the alias exists but no target is currently routable', async () => {
  setRoutable(); // catalog empty
  await assertRejects(
    () => resolveAlias({
      ...RESOLVE_DEFAULTS,
      modelName: 'gpt-fast',
      repo: stubRepoFor(aliasRecord({
        targets: [
          { target_model_id: 'gpt-5.4', rules: {} },
          { target_model_id: 'gpt-5.5', rules: {} },
        ],
      })),
    }),
    AliasNoTargetAvailableError,
    "alias 'gpt-fast' has 2 target(s); none currently map to an enabled upstream binding",
  );
});

test('first-available skips unroutable rows and picks the first available, not the first listed', async () => {
  setRoutable('gpt-5.5'); // `gpt-5.4` is not in the catalog
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    modelName: 'gpt-fast',
    repo: stubRepoFor(aliasRecord({
      targets: [
        { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'high' } } },
        { target_model_id: 'gpt-5.5', rules: { reasoning: { effort: 'low' } } },
        { target_model_id: 'gpt-6', rules: {} },
      ],
    })),
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'gpt-5.5');
  assertEquals(result.rules, { reasoning: { effort: 'low' } });
});

test('random selection picks every available target across enough iterations', async () => {
  setRoutable('a', 'b');
  const seen = new Set<string>();
  for (let i = 0; i < 100; i += 1) {
    const result = await resolveAlias({
      ...RESOLVE_DEFAULTS,
      modelName: 'gpt-fast',
      repo: stubRepoFor(aliasRecord({
        selection: 'random',
        targets: [
          { target_model_id: 'a', rules: {} },
          { target_model_id: 'b', rules: {} },
        ],
      })),
    });
    assert(result !== null);
    seen.add(result.targetModelId);
    if (seen.size === 2) break;
  }
  // Two targets, both routable, 100 iterations: hitting only one is a
  // (1/2)^100 fluke. Treat anything less than two distinct picks as a real
  // regression in the selection logic, not coincidence.
  assertEquals(seen.size, 2);
});

test('shadow pattern: alias whose first target equals its own name picks the real model when present', async () => {
  setRoutable('codex-auto-review'); // the real model IS in the catalog
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    modelName: 'codex-auto-review',
    repo: stubRepoFor(aliasRecord({
      name: 'codex-auto-review',
      targets: [
        { target_model_id: 'codex-auto-review', rules: {} },
        { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
      ],
    })),
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'codex-auto-review');
  assertEquals(result.rules, {});
});

test('shadow pattern: alias falls back to the second target when the real model is not in the catalog', async () => {
  setRoutable('gpt-5.4'); // only the fallback is routable
  const result = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    modelName: 'codex-auto-review',
    repo: stubRepoFor(aliasRecord({
      name: 'codex-auto-review',
      targets: [
        { target_model_id: 'codex-auto-review', rules: {} },
        { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
      ],
    })),
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'gpt-5.4');
  assertEquals(result.rules, { reasoning: { effort: 'low' } });
});

test('embedding-kind alias accepts only embedding endpoints', async () => {
  routableModels.clear();
  routableModels.set('text-embedding-3', { endpoints: { embeddings: {} } });
  routableModels.set('gpt-5.4', { endpoints: ALWAYS_ROUTABLE_ENDPOINTS });

  const okResult = await resolveAlias({
    ...RESOLVE_DEFAULTS,
    endpointKind: 'embedding',
    modelName: 'embed-fast',
    repo: stubRepoFor(aliasRecord({ name: 'embed-fast', kind: 'embedding', targets: [{ target_model_id: 'text-embedding-3', rules: {} }] })),
  });
  assert(okResult !== null);
  assertEquals(okResult.targetModelId, 'text-embedding-3');

  await assertRejects(
    () => resolveAlias({
      ...RESOLVE_DEFAULTS,
      endpointKind: 'embedding',
      modelName: 'embed-fast',
      // gpt-5.4 is in the catalog but only exposes chat endpoints, so it
      // cannot satisfy an embedding-kind alias.
      repo: stubRepoFor(aliasRecord({ name: 'embed-fast', kind: 'embedding', targets: [{ target_model_id: 'gpt-5.4', rules: {} }] })),
    }),
    AliasNoTargetAvailableError,
  );
});
