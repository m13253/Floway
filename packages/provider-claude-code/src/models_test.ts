import { describe, expect, test } from 'vitest';

import { buildClaudeCodeModels, claudeCodeResolveRequestedModelId } from './models.ts';
import type { ClaudeCodeProviderData } from './types.ts';

describe('claude-code model catalog', () => {
  const models = buildClaudeCodeModels(new Set<string>());

  test('ships exactly three public aliases — sonnet / opus / haiku', () => {
    expect(models.map(m => m.id)).toEqual([
      'claude-sonnet-4-5',
      'claude-opus-4-5',
      'claude-haiku-4-5',
    ]);
  });

  test('each model carries the dated upstream id under providerData', () => {
    const expected: Record<string, string> = {
      'claude-sonnet-4-5': 'claude-sonnet-4-5-20250929',
      'claude-opus-4-5': 'claude-opus-4-5-20251101',
      'claude-haiku-4-5': 'claude-haiku-4-5-20251001',
    };
    for (const m of models) {
      const data = m.providerData as ClaudeCodeProviderData | undefined;
      expect(data?.upstreamModelId).toBe(expected[m.id]);
    }
  });

  test('every model advertises only the messages endpoint and chat kind', () => {
    for (const m of models) {
      expect(m.endpoints).toEqual({ messages: {} });
      expect(m.kind).toBe('chat');
      expect(m.owned_by).toBe('anthropic');
    }
  });

  test('every model has non-null pricing pulled from the pricing table', () => {
    for (const m of models) {
      expect(m.cost).toBeDefined();
      expect(typeof m.cost!.input).toBe('number');
      expect(typeof m.cost!.output).toBe('number');
    }
  });

  test('sonnet carries the 1M context-window upper bound', () => {
    const sonnet = models[0]!;
    expect(sonnet.limits.max_context_window_tokens).toBe(1_000_000);
  });

  test('forwards the supplied enabledFlags set onto every model', () => {
    const flags = new Set(['custom-flag-a', 'custom-flag-b']);
    const built = buildClaudeCodeModels(flags);
    for (const m of built) {
      expect(m.enabledFlags).toBe(flags);
    }
  });
});

describe('claudeCodeResolveRequestedModelId', () => {
  test('resolves a dated id to its public alias', () => {
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-20250929')).toBe('claude-sonnet-4-5');
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-5-20251101')).toBe('claude-opus-4-5');
    expect(claudeCodeResolveRequestedModelId('claude-haiku-4-5-20251001')).toBe('claude-haiku-4-5');
  });

  test('returns undefined when the id is already a public alias', () => {
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-opus-4-5')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-haiku-4-5')).toBeUndefined();
  });

  test('returns undefined for an unknown dated id (different family or revision)', () => {
    // Family the catalog does not advertise — must not resolve to any alias.
    expect(claudeCodeResolveRequestedModelId('claude-foo-4-5-20250101')).toBeUndefined();
    // Family we ship, revision we do not.
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-20991231')).toBeUndefined();
  });

  test('returns undefined for ids outside the dated pattern', () => {
    expect(claudeCodeResolveRequestedModelId('gpt-5')).toBeUndefined();
    expect(claudeCodeResolveRequestedModelId('claude-sonnet-4-5-foo')).toBeUndefined();
  });
});
