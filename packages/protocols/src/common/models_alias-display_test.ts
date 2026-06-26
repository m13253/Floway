import { describe, expect, test } from 'vitest';

import { composeAliasDisplayName, formatAliasRulesInline } from './models.ts';

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

  test('omits the rules suffix when rules are empty', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'GPT-5.4',
        rules: {},
      }),
    ).toBe('GPT-5.4');
  });

  test('formats each rule field with its canonical suffix when alias displayName is missing', () => {
    const target = 'GPT-5.4';
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { reasoning: { effort: 'high' } } })).toBe('GPT-5.4 (high effort)');
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { reasoning: { budgetTokens: 4096 } } })).toBe('GPT-5.4 (4096tk reasoning)');
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { reasoning: { adaptive: true } } })).toBe('GPT-5.4 (adaptive reasoning)');
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { reasoning: { summary: 'detailed' } } })).toBe('GPT-5.4 (detailed summary)');
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { verbosity: 'low' } })).toBe('GPT-5.4 (low verbosity)');
    expect(composeAliasDisplayName({ targetDisplayName: target, rules: { serviceTier: 'priority' } })).toBe('GPT-5.4 (priority tier)');
  });

  test('sorts anthropicBeta tokens and joins with slashes', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'Claude',
        rules: { anthropicBeta: ['extended-thinking', 'fast-mode-2026-02-01'] },
      }),
    ).toBe('Claude (extended-thinking/fast-mode-2026-02-01)');
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'Claude',
        rules: { anthropicBeta: ['fast-mode-2026-02-01', 'extended-thinking'] },
      }),
    ).toBe('Claude (extended-thinking/fast-mode-2026-02-01)');
  });

  test('drops anthropicBeta when the token list is empty', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'Claude',
        rules: { anthropicBeta: [] },
      }),
    ).toBe('Claude');
  });

  test('joins multiple fields with comma in deterministic order', () => {
    expect(
      composeAliasDisplayName({
        targetDisplayName: 'GPT-5.4',
        rules: {
          reasoning: { effort: 'low', summary: 'concise' },
          verbosity: 'high',
          serviceTier: 'flex',
        },
      }),
    ).toBe('GPT-5.4 (low effort, concise summary, high verbosity, flex tier)');
  });
});

describe('formatAliasRulesInline', () => {
  test('returns empty string when no rule applies', () => {
    expect(formatAliasRulesInline({})).toBe('');
  });

  test('returns each rule field with the same compact wording as the parenthesized suffix, sans parens', () => {
    expect(formatAliasRulesInline({ reasoning: { effort: 'low' } })).toBe('low effort');
    expect(formatAliasRulesInline({ reasoning: { budgetTokens: 4096 } })).toBe('4096tk reasoning');
    expect(formatAliasRulesInline({ reasoning: { adaptive: true } })).toBe('adaptive reasoning');
    expect(formatAliasRulesInline({ reasoning: { summary: 'detailed' } })).toBe('detailed summary');
  });

  test('joins multiple fields with comma in the same order composeAliasDisplayName uses', () => {
    expect(
      formatAliasRulesInline({
        reasoning: { effort: 'low', summary: 'detailed' },
        verbosity: 'high',
        serviceTier: 'fast',
      }),
    ).toBe('low effort, detailed summary, high verbosity, fast tier');
  });

  test('sorts anthropicBeta tokens and joins with slashes', () => {
    expect(
      formatAliasRulesInline({ anthropicBeta: ['fast-mode-2026-02-01', 'extended-thinking'] }),
    ).toBe('extended-thinking/fast-mode-2026-02-01');
  });
});
