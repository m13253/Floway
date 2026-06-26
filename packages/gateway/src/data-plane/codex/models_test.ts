import { describe, expect, test } from 'vitest';

import { computeCatalog } from './models.ts';
import type { InternalModel } from '@floway-dev/provider';

const bundled = {
  models: [
    { slug: 'gpt-5.5', display_name: 'GPT-5.5', context_window: 272000, priority: 1, visibility: 'list', extra: 'keep', service_tiers: [] },
    { slug: 'gpt-5.4', display_name: 'GPT-5.4', context_window: 272000, priority: 2, visibility: 'list', service_tiers: [] },
    { slug: 'codex-auto-review', display_name: 'Codex Auto Review', context_window: 272000, visibility: 'hide', service_tiers: [] },
  ],
};

const chat = (id: string, displayName?: string, ctx = 100000): InternalModel => ({
  id,
  display_name: displayName,
  kind: 'chat',
  limits: { max_context_window_tokens: ctx },
});

describe('computeCatalog', () => {
  test('bundled match: reuses bundled entry, slug=publicId, display_name from registry', () => {
    const out = computeCatalog(bundled, [chat('gpt-5.5', 'Custom Display Name', 200000)]);
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('gpt-5.5');
    expect(e.display_name).toBe('Custom Display Name');
    expect(e.context_window).toBe(200000);   // applyContextWindowFromRegistry rewrites
    expect(e.priority).toBe(1);
    expect((e as Record<string, unknown>).extra).toBe('keep');  // arbitrary bundled fields stay
  });

  test('segment match via prefix and suffix', () => {
    const out = computeCatalog(bundled, [
      chat('openrouter/gpt-5.5:nitro'),
      chat('azure/gpt-5.4'),
    ]);
    expect(out.models.map(m => m.slug)).toEqual(['openrouter/gpt-5.5:nitro', 'azure/gpt-5.4']);
    expect(out.models[0].priority).toBe(1);
    expect(out.models[1].priority).toBe(2);
  });

  test('multiple bundled-matching ids of the same bundled slug coexist', () => {
    const out = computeCatalog(bundled, [chat('gpt-5.5'), chat('openrouter/gpt-5.5:nitro')]);
    expect(out.models).toHaveLength(2);
    expect(out.models.every(m => m.priority === 1)).toBe(true);
  });

  test('first segment match wins', () => {
    // openrouter/gpt-5.5/gpt-5.4 — the first match should be gpt-5.5
    const out = computeCatalog(bundled, [chat('openrouter/gpt-5.5/gpt-5.4')]);
    expect(out.models[0].priority).toBe(1);  // gpt-5.5's priority
  });

  test('no match: synthesizes a new entry', () => {
    const out = computeCatalog(bundled, [chat('deepseek-v4-pro', 'DeepSeek V4 Pro', 128000)]);
    expect(out.models).toHaveLength(1);
    const e = out.models[0];
    expect(e.slug).toBe('deepseek-v4-pro');
    expect(e.display_name).toBe('DeepSeek V4 Pro');
    expect(e.context_window).toBe(128000);
    expect(e.shell_type).toBe('shell_command');     // hardcoded baseline
    expect(e.prefer_websockets).toBe(true);
  });

  test('non-chat models are dropped', () => {
    const out = computeCatalog(bundled, [
      { id: 'text-embedding-3', display_name: 'emb', kind: 'embedding', limits: {} },
      chat('gpt-5.5'),
    ] as InternalModel[]);
    expect(out.models).toHaveLength(1);
    expect(out.models[0].slug).toBe('gpt-5.5');
  });

  test('alias appears when target is in registry', () => {
    const out = computeCatalog(bundled, [chat('gpt-5.4')]);   // gpt-5.4 is CODEX_AUTO_REVIEW_TARGET
    expect(out.models.map(m => m.slug)).toContain('codex-auto-review');
  });

  test('alias absent when target not in registry', () => {
    const out = computeCatalog(bundled, [chat('gpt-5.5')]);
    expect(out.models.map(m => m.slug)).not.toContain('codex-auto-review');
  });

  test('throws when alias target is in registry but bundled lacks the alias entry', () => {
    const bundledWithoutAlias = { models: bundled.models.filter(m => m.slug !== 'codex-auto-review') };
    expect(() => computeCatalog(bundledWithoutAlias, [chat('gpt-5.4')])).toThrow(/codex-auto-review/);
  });

  test('bundled reuse: registry cost.tiers replaces bundled service_tiers', () => {
    const im: InternalModel = {
      ...chat('openrouter/gpt-5.5:nitro'),
      cost: { tiers: { fast: { input: 1 } } },
    };
    const out = computeCatalog(bundled, [im]);
    expect(out.models[0].service_tiers).toEqual([{ id: 'fast', name: 'fast', description: '' }]);
  });

  test('bundled reuse: no registry cost.tiers yields service_tiers: []', () => {
    const out = computeCatalog(bundled, [chat('openrouter/gpt-5.5:nitro')]);
    expect(out.models[0].service_tiers).toEqual([]);
  });
});
