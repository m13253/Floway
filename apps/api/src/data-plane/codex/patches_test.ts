import { describe, expect, it } from 'vitest';

import { applyCodexOverrides, CODEX_MODEL_OVERRIDES, type CodexCatalog } from './patches.ts';

describe('applyCodexOverrides', () => {
  it('overrides only the fields declared per slug, leaves other entries untouched', () => {
    const input: CodexCatalog = {
      models: [
        { slug: 'gpt-5.5', context_window: 272000, base_instructions: 'unchanged' },
        { slug: 'gpt-5.4', context_window: 272000 },
      ],
    };
    const out = applyCodexOverrides(input);
    const gpt55 = out.models.find(m => m.slug === 'gpt-5.5');
    expect(gpt55).toMatchObject({
      slug: 'gpt-5.5',
      context_window: 1050000,
      max_context_window: 1050000,
      effective_context_window_percent: 100,
      auto_compact_token_limit: 945000,
      base_instructions: 'unchanged',
    });
    expect(out.models.find(m => m.slug === 'gpt-5.4')).toEqual({ slug: 'gpt-5.4', context_window: 272000 });
  });

  it('returns input shape unchanged when no slug matches an override', () => {
    const input: CodexCatalog = { models: [{ slug: 'gpt-5.4-mini', context_window: 272000 }] };
    expect(applyCodexOverrides(input)).toEqual(input);
  });

  it('does not mutate the input catalog', () => {
    const input: CodexCatalog = { models: [{ slug: 'gpt-5.5', context_window: 272000 }] };
    const snapshot = JSON.parse(JSON.stringify(input)) as CodexCatalog;
    applyCodexOverrides(input);
    expect(input).toEqual(snapshot);
  });

  it('declares every override field as a numeric value matching the 1M-context contract', () => {
    expect(CODEX_MODEL_OVERRIDES['gpt-5.5']).toEqual({
      context_window: 1050000,
      max_context_window: 1050000,
      effective_context_window_percent: 100,
      auto_compact_token_limit: 945000,
    });
  });
});
