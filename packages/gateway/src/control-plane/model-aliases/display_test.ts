import { describe, expect, test } from 'vitest';

import { composeAliasDisplayName, formatAliasRulesSummary } from './display.ts';

describe('formatAliasRulesSummary', () => {
  test('returns empty string when no rules are set', () => {
    expect(formatAliasRulesSummary({})).toBe('');
  });

  test('formats each rule field with its canonical suffix', () => {
    expect(formatAliasRulesSummary({ reasoning: { effort: 'high' } })).toBe(' (high effort)');
    expect(formatAliasRulesSummary({ reasoning: { budgetTokens: 4096 } })).toBe(' (4096tk reasoning)');
    expect(formatAliasRulesSummary({ reasoning: { adaptive: true } })).toBe(' (adaptive reasoning)');
    expect(formatAliasRulesSummary({ reasoning: { summary: 'detailed' } })).toBe(' (detailed summary)');
    expect(formatAliasRulesSummary({ verbosity: 'low' })).toBe(' (low verbosity)');
    expect(formatAliasRulesSummary({ serviceTier: 'priority' })).toBe(' (priority tier)');
    expect(formatAliasRulesSummary({ anthropicSpeed: 'fast' })).toBe(' (fast speed)');
  });

  test('sorts anthropicBeta tokens and joins with slashes', () => {
    expect(formatAliasRulesSummary({ anthropicBeta: ['extended-thinking', 'fast-mode-2026-02-01'] })).toBe(
      ' (extended-thinking/fast-mode-2026-02-01)',
    );
    expect(formatAliasRulesSummary({ anthropicBeta: ['fast-mode-2026-02-01', 'extended-thinking'] })).toBe(
      ' (extended-thinking/fast-mode-2026-02-01)',
    );
  });

  test('drops anthropicBeta when the token list is empty', () => {
    expect(formatAliasRulesSummary({ anthropicBeta: [] })).toBe('');
  });

  test('joins multiple fields with comma in deterministic order', () => {
    expect(
      formatAliasRulesSummary({
        reasoning: { effort: 'low', summary: 'concise' },
        verbosity: 'high',
        anthropicSpeed: 'fast',
      }),
    ).toBe(' (low effort, concise summary, high verbosity, fast speed)');
  });
});

describe('composeAliasDisplayName', () => {
  test('uses alias displayName when set, suppressing the rules summary', () => {
    expect(
      composeAliasDisplayName({
        aliasDisplayName: 'Codex Auto Review',
        targetDisplayName: 'GPT-5.4',
        rules: { reasoning: { effort: 'low' } },
      }),
    ).toBe('Codex Auto Review');
  });

  test('falls back to target displayName with rules suffix when alias displayName is missing', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'GPT-5.4',
        rules: { reasoning: { effort: 'low' } },
      }),
    ).toBe('GPT-5.4 (low effort)');
  });

  test('omits the rules suffix when rules are empty', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'GPT-5.4',
        rules: {},
      }),
    ).toBe('GPT-5.4');
  });
});
