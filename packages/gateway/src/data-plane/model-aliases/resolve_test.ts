// Behavioral coverage for the alias resolver. Mocks the lower-layer
// catalog seam (`enumerateRealModelCandidates` out of `providers/registry.ts`)
// so each test can hand-script which target model ids look routable AND
// what endpoint map their candidate advertises; the resolver itself runs
// unmocked, so its filter logic (availability via the endpointAccepts
// predicate, selection strategy) is the thing under test.

import { test, vi } from 'vitest';

import type { ModelAliasRecord, ModelAliasesRepo } from '../../repo/types.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import { directFetcher, type Fetcher, type ProviderCandidate } from '@floway-dev/provider';
import { assert, assertEquals, assertRejects } from '@floway-dev/test-utils';

// id → endpoint map. Absent ids look unroutable; present ids return
// candidates whose model advertises the given endpoints, so the resolver's
// `endpointAccepts` predicate can filter them.
const routableModels = new Map<string, ModelEndpoints>();

vi.mock('../providers/registry.ts', () => ({
  enumerateRealModelCandidates: vi.fn(async (modelId: string, _kind: string, providers: readonly { upstream: string }[]) => {
    const endpoints = routableModels.get(modelId);
    if (endpoints === undefined) return { candidates: [], sawAnyId: false, failedUpstreams: [] };
    const candidates = providers.map(p => ({
      provider: p,
      model: { id: modelId, endpoints },
      fetcher: directFetcher,
    } as unknown as ProviderCandidate));
    return { candidates, sawAnyId: true, failedUpstreams: [] };
  }),
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
  announcedMetadata: null,
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

const fetcherForUpstream: (upstreamId: string) => Fetcher = () => directFetcher;
const providers = [{ upstream: 'u_test', name: 'u_test', modelPrefix: null }] as unknown as Parameters<typeof resolveAlias>[0]['providers'];

const RESOLVE_DEFAULTS = {
  providers,
  fetcherForUpstream,
  scheduler: () => {},
  kind: 'chat' as const,
};

// Mark these ids routable with the full chat-three endpoint set — most
// tests only care about availability, not which endpoint surface the
// binding advertises. Endpoint-aware tests use `setRoutableWith` below.
const setRoutable = (...ids: string[]): void => {
  routableModels.clear();
  for (const id of ids) routableModels.set(id, { chatCompletions: {}, messages: {}, responses: {} });
};

// Endpoint-aware variant: each id carries the exact endpoint map its
// binding advertises. Lets a test pin "target A serves /chat/completions,
// target B only serves /messages" so the resolver's pool-narrowing can
// be verified.
const setRoutableWith = (entries: Record<string, ModelEndpoints>): void => {
  routableModels.clear();
  for (const [id, endpoints] of Object.entries(entries)) routableModels.set(id, endpoints);
};

test('returns null when no alias matches the inbound name', async () => {
  setRoutable('gpt-5.4');
  const result = await resolveAlias({
    endpointAccepts: () => true,
    ...RESOLVE_DEFAULTS,
    modelName: 'not-an-alias',
    repo: stubRepoFor(null),
  });
  assertEquals(result, null);
});

test('returns the target and rules when a single target is available', async () => {
  setRoutable('gpt-5.4');
  const result = await resolveAlias({
    endpointAccepts: () => true,
    ...RESOLVE_DEFAULTS,
    modelName: 'gpt-fast',
    repo: stubRepoFor(aliasRecord()),
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'gpt-5.4');
  assertEquals(result.aliasName, 'gpt-fast');
  assertEquals(result.rules, { reasoning: { effort: 'low' } });
});

test('throws AliasNoTargetAvailableError when the alias exists but no target is currently routable', async () => {
  setRoutable(); // catalog empty
  await assertRejects(
    () => resolveAlias({
      endpointAccepts: () => true,
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
    endpointAccepts: () => true,
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
      endpointAccepts: () => true,
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
    endpointAccepts: () => true,
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
    endpointAccepts: () => true,
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

test('endpoint-aware pool: random selection picks ONLY from targets whose binding serves the inbound endpoint', async () => {
  // Two targets: A serves /chat/completions; B only serves /messages.
  // Inbound endpoint = /chat/completions (predicate keeps only A). Run 50
  // iterations of `random` selection and assert B is never picked — if
  // the resolver were endpoint-blind, B would surface ~half the time and
  // the downstream prefix router would 404.
  setRoutableWith({
    'serves-cc': { chatCompletions: {} },
    'serves-messages-only': { messages: {} },
  });
  const repo = stubRepoFor(aliasRecord({
    selection: 'random',
    targets: [
      { target_model_id: 'serves-cc', rules: {} },
      { target_model_id: 'serves-messages-only', rules: {} },
    ],
  }));
  const picks = new Set<string>();
  for (let i = 0; i < 50; i++) {
    const result = await resolveAlias({
      modelName: 'gpt-fast',
      ...RESOLVE_DEFAULTS,
      endpointAccepts: endpoints => endpoints.chatCompletions !== undefined,
      repo,
    });
    assert(result !== null);
    picks.add(result.targetModelId);
  }
  assertEquals([...picks], ['serves-cc']);
});

test('endpoint-aware pool: first-available skips targets whose binding does not serve the inbound endpoint', async () => {
  // Configured order [A, B]: A only serves /messages, B serves /chat/completions.
  // Inbound endpoint = /chat/completions. first-available without endpoint
  // narrowing would pick A and downstream 404. With narrowing the pool
  // becomes [B], and first-available returns B.
  setRoutableWith({
    'messages-only': { messages: {} },
    'serves-cc': { chatCompletions: {} },
  });
  const repo = stubRepoFor(aliasRecord({
    selection: 'first-available',
    targets: [
      { target_model_id: 'messages-only', rules: {} },
      { target_model_id: 'serves-cc', rules: {} },
    ],
  }));
  const result = await resolveAlias({
    modelName: 'gpt-fast',
    ...RESOLVE_DEFAULTS,
    endpointAccepts: endpoints => endpoints.chatCompletions !== undefined,
    repo,
  });
  assert(result !== null);
  assertEquals(result.targetModelId, 'serves-cc');
});

test('endpoint-aware pool: alias with NO target serving the inbound endpoint throws AliasNoTargetAvailableError and pins the endpoint-mismatch wording', async () => {
  setRoutableWith({
    'a': { messages: {} },
    'b': { messages: {} },
  });
  const repo = stubRepoFor(aliasRecord({
    targets: [
      { target_model_id: 'a', rules: {} },
      { target_model_id: 'b', rules: {} },
    ],
  }));
  await assertRejects(
    () => resolveAlias({
      modelName: 'gpt-fast',
      ...RESOLVE_DEFAULTS,
      endpointAccepts: endpoints => endpoints.chatCompletions !== undefined,
      repo,
    }),
    AliasNoTargetAvailableError,
    'none currently serves the inbound endpoint',
  );
});

test('alias with every target unresolvable to any upstream throws AliasNoTargetAvailableError and pins the no-binding wording', async () => {
  // Empty routable map → no target resolves to any binding at all. The
  // error message stays on the canonical "no enabled upstream binding"
  // wording so an operator who removed every binding sees that hint
  // rather than the endpoint-mismatch one.
  setRoutableWith({});
  const repo = stubRepoFor(aliasRecord({
    targets: [
      { target_model_id: 'gone-1', rules: {} },
      { target_model_id: 'gone-2', rules: {} },
    ],
  }));
  await assertRejects(
    () => resolveAlias({
      modelName: 'gpt-fast',
      ...RESOLVE_DEFAULTS,
      endpointAccepts: () => true,
      repo,
    }),
    AliasNoTargetAvailableError,
    'none currently map to an enabled upstream binding',
  );
});

test('alias with mixed no-binding + endpoint-mismatch rejections falls back to the generic no-binding wording', async () => {
  // Only the "every dropped target was endpoint-mismatched" branch earns
  // the endpoint-specific hint. As soon as one target is dropped for a
  // different reason (here `gone` never resolved to any binding at all),
  // the resolver reverts to the generic wording so the operator does not
  // read the endpoint hint as a summary that also applies to the missing
  // target.
  setRoutableWith({
    'messages-only': { messages: {} },
  });
  const repo = stubRepoFor(aliasRecord({
    targets: [
      { target_model_id: 'gone', rules: {} },
      { target_model_id: 'messages-only', rules: {} },
    ],
  }));
  await assertRejects(
    () => resolveAlias({
      modelName: 'gpt-fast',
      ...RESOLVE_DEFAULTS,
      endpointAccepts: endpoints => endpoints.chatCompletions !== undefined,
      repo,
    }),
    AliasNoTargetAvailableError,
    'none currently map to an enabled upstream binding',
  );
});

test('random selection with a single available target pins to that target across every iteration', async () => {
  // Regression pin for the pool-of-one degenerate: `Math.floor(Math.random()
  // * 1)` is always 0, so `random` with a single-target pool must return
  // the same id every time — no off-by-one that would index into an empty
  // slot and blow up with `undefined.target_model_id`.
  setRoutable('only-target');
  const repo = stubRepoFor(aliasRecord({
    selection: 'random',
    targets: [{ target_model_id: 'only-target', rules: {} }],
  }));
  for (let i = 0; i < 100; i++) {
    const result = await resolveAlias({
      modelName: 'gpt-fast',
      ...RESOLVE_DEFAULTS,
      endpointAccepts: () => true,
      repo,
    });
    assert(result !== null);
    assertEquals(result.targetModelId, 'only-target');
  }
});
