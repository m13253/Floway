import { describe, expect, it } from 'vitest';

import type { CodexCatalog } from './catalog.ts';
import { applyCodexOverrides } from './patches.ts';

describe('applyCodexOverrides', () => {
  const ONE_M = {
    context_window: 1050000,
    max_context_window: 1050000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: 945000,
  };

  it('overrides only the fields declared per slug, leaves other entries untouched', () => {
    const input: CodexCatalog = {
      models: [
        { slug: 'gpt-5.5', context_window: 272000, base_instructions: 'unchanged' },
        { slug: 'gpt-5.4', context_window: 272000, base_instructions: 'unchanged-too' },
        { slug: 'gpt-5.3-codex', context_window: 272000 },
      ],
    };
    const out = applyCodexOverrides(input);
    expect(out.models.find(m => m.slug === 'gpt-5.5')).toMatchObject({ slug: 'gpt-5.5', ...ONE_M, base_instructions: 'unchanged' });
    expect(out.models.find(m => m.slug === 'gpt-5.4')).toMatchObject({ slug: 'gpt-5.4', ...ONE_M, base_instructions: 'unchanged-too' });
    expect(out.models.find(m => m.slug === 'gpt-5.3-codex')).toEqual({ slug: 'gpt-5.3-codex', context_window: 272000 });
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
});
