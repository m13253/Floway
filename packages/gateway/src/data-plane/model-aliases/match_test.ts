import { describe, expect, test } from 'vitest';

import { matchAlias } from './match.ts';
import type { ModelAlias } from '../../control-plane/model-aliases/types.ts';

const make = (overrides: Partial<ModelAlias>): ModelAlias => ({
  alias: 'a',
  targetModelId: 't',
  upstreamIds: [],
  rules: {},
  visibleInModelsList: true,
  onConflict: 'real-only',
  createdAt: 0,
  ...overrides,
});

describe('matchAlias', () => {
  test('matches by exact lookupId when alias has no upstream filter', () => {
    const aliases = [make({ alias: 'codex-auto-review', targetModelId: 'gpt-5.4' })];
    expect(matchAlias('codex-auto-review', 'up-1', aliases)?.alias).toBe('codex-auto-review');
  });

  test('does not match when lookupId differs', () => {
    const aliases = [make({ alias: 'codex-auto-review' })];
    expect(matchAlias('something-else', 'up-1', aliases)).toBeUndefined();
  });

  test('respects upstreamIds allowlist (member matches)', () => {
    const aliases = [make({ alias: 'a', upstreamIds: ['up-1', 'up-2'] })];
    expect(matchAlias('a', 'up-1', aliases)).toBeDefined();
    expect(matchAlias('a', 'up-2', aliases)).toBeDefined();
  });

  test('respects upstreamIds allowlist (non-member misses)', () => {
    const aliases = [make({ alias: 'a', upstreamIds: ['up-1'] })];
    expect(matchAlias('a', 'up-3', aliases)).toBeUndefined();
  });

  test('empty upstreamIds means match-any', () => {
    const aliases = [make({ alias: 'a', upstreamIds: [] })];
    expect(matchAlias('a', 'anywhere', aliases)).toBeDefined();
  });

  test('returns the first matching alias entry verbatim', () => {
    const aliases = [
      make({ alias: 'a', targetModelId: 'first', rules: { reasoning: { effort: 'low' } } }),
      make({ alias: 'a', targetModelId: 'second' }),
    ];
    expect(matchAlias('a', 'up-x', aliases)).toEqual(aliases[0]);
  });

  test('returns undefined for an empty alias list', () => {
    expect(matchAlias('a', 'up-x', [])).toBeUndefined();
  });
});
