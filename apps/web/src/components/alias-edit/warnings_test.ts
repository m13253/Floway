import { describe, expect, it } from 'vitest';

import { computeModelWarnings, computeRuleWarnings, computeShadowWarning, findCatalogModel, realModelIds } from './warnings.ts';
import type { ControlPlaneModel } from '../../api/types.ts';

const realModel = (over: Partial<ControlPlaneModel> & { id: string }): ControlPlaneModel => ({
  upstreams: [{ id: 'u1', name: 'U1', kind: 'custom' }],
  ...over,
});

const aliasModel = (over: Partial<ControlPlaneModel> & { id: string }): ControlPlaneModel => ({
  upstreams: [],
  aliasedFrom: { name: over.id, kind: 'chat', selection: 'first-available', targets: [] },
  ...over,
});

describe('realModelIds', () => {
  it('excludes alias entries and returns the remaining ids in catalog order', () => {
    const catalog: ControlPlaneModel[] = [
      realModel({ id: 'gpt-5' }),
      aliasModel({ id: 'auto-review' }),
      realModel({ id: 'claude-sonnet' }),
    ];
    expect(realModelIds(catalog)).toEqual(['gpt-5', 'claude-sonnet']);
  });

  it('returns an empty array for a null or missing catalog', () => {
    expect(realModelIds(null)).toEqual([]);
    expect(realModelIds(undefined)).toEqual([]);
  });
});

describe('findCatalogModel', () => {
  it('looks up the catalog row by id', () => {
    const catalog: ControlPlaneModel[] = [realModel({ id: 'gpt-5' }), realModel({ id: 'claude' })];
    expect(findCatalogModel(catalog, 'claude')?.id).toBe('claude');
    expect(findCatalogModel(catalog, 'unknown')).toBeUndefined();
  });

  it('skips alias rows that share an id with a target — they never re-enter the alias layer at runtime', () => {
    // Both rows share id 'auto-review' (the alias name shadowing nothing
    // real). findCatalogModel must not return the alias entry — its
    // capability metadata is the wrong source for a real-model rule
    // warning. computeModelWarnings should treat the id as unknown
    // instead.
    const catalog: ControlPlaneModel[] = [aliasModel({ id: 'auto-review' })];
    expect(findCatalogModel(catalog, 'auto-review')).toBeUndefined();
  });
});

describe('computeModelWarnings', () => {
  it('returns no warning when the target resolves to a catalog entry', () => {
    const catalog = realModel({ id: 'gpt-5' });
    expect(computeModelWarnings('gpt-5', catalog)).toEqual([]);
  });

  it('returns a "does not resolve" warning when the target is unknown', () => {
    const w = computeModelWarnings('mystery-model', undefined);
    expect(w).toHaveLength(1);
    expect(w[0]).toContain('mystery-model');
    expect(w[0]).toContain('does not currently resolve');
  });

  it('emits no warning for an empty id (the row is mid-edit)', () => {
    expect(computeModelWarnings('', undefined)).toEqual([]);
  });
});

describe('computeRuleWarnings', () => {
  const catalogWithReasoning = realModel({
    id: 'gpt-5',
    chat: {
      reasoning: {
        effort: { supported: ['low', 'medium'], default: 'medium' },
        budget_tokens: { min: 100, max: 1000 },
      },
    },
  });

  it('flags effort values not in the advertised supported list', () => {
    const w = computeRuleWarnings({ reasoning: { effort: 'xhigh' } }, catalogWithReasoning);
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('reasoning.effort');
    expect(w[0].message).toContain('low, medium');
  });

  it('does not flag effort values that are advertised', () => {
    const w = computeRuleWarnings({ reasoning: { effort: 'low' } }, catalogWithReasoning);
    expect(w).toEqual([]);
  });

  it('flags budgets outside the advertised range', () => {
    const tooHigh = computeRuleWarnings({ reasoning: { budget_tokens: 5000 } }, catalogWithReasoning);
    expect(tooHigh[0].field).toBe('reasoning.budget_tokens');
    expect(tooHigh[0].message).toContain('1000');
    const tooLow = computeRuleWarnings({ reasoning: { budget_tokens: 10 } }, catalogWithReasoning);
    expect(tooLow[0].field).toBe('reasoning.budget_tokens');
    expect(tooLow[0].message).toContain('100');
  });

  it('flags adaptive=true when the target does not advertise adaptive', () => {
    const w = computeRuleWarnings({ reasoning: { adaptive: true } }, catalogWithReasoning);
    expect(w).toHaveLength(1);
    expect(w[0].field).toBe('reasoning.adaptive');
  });

  it('flags reasoning at all when the target lacks reasoning metadata', () => {
    const noReasoning = realModel({ id: 'gpt-5', chat: {} });
    const w = computeRuleWarnings({ reasoning: { effort: 'low' } }, noReasoning);
    expect(w[0].field).toBe('reasoning.effort');
    expect(w[0].message).toContain('does not advertise');
  });
});

describe('computeShadowWarning', () => {
  const catalog: ControlPlaneModel[] = [
    realModel({ id: 'gpt-5', display_name: 'GPT 5' }),
    realModel({ id: 'plain' }),
    aliasModel({ id: 'auto-review' }),
  ];

  it('returns null when the alias name does not match any real model id', () => {
    expect(computeShadowWarning('not-a-real-id', [{ target_model_id: 'gpt-5' }], catalog)).toBeNull();
  });

  it('returns null when the alias name matches another alias (not a real model)', () => {
    expect(computeShadowWarning('auto-review', [{ target_model_id: 'gpt-5' }], catalog)).toBeNull();
  });

  it('returns null when one of the targets references the shadowed id (seed pattern)', () => {
    expect(computeShadowWarning('gpt-5', [{ target_model_id: 'gpt-5' }, { target_model_id: 'plain' }], catalog)).toBeNull();
  });

  it('returns the shadowed id with display_name only when display_name differs from id', () => {
    const w1 = computeShadowWarning('gpt-5', [{ target_model_id: 'plain' }], catalog);
    expect(w1).toEqual({ shadowedId: 'gpt-5', shadowedDisplayName: 'GPT 5' });
    const w2 = computeShadowWarning('plain', [{ target_model_id: 'gpt-5' }], catalog);
    expect(w2).toEqual({ shadowedId: 'plain', shadowedDisplayName: null });
  });

  it('returns null on an empty alias name (mid-edit)', () => {
    expect(computeShadowWarning('', [{ target_model_id: 'gpt-5' }], catalog)).toBeNull();
  });
});
