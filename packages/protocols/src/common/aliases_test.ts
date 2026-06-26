import { describe, expect, test } from 'vitest';

import { composeAliasDisplayName, formatAliasRuleBadges, formatAliasRulesInline } from './aliases.ts';

describe('composeAliasDisplayName', () => {
  test('bare target id when no rules apply', () => {
    expect(composeAliasDisplayName('gpt-5.4', {})).toBe('gpt-5.4');
  });

  test('parenthesizes the inline summary when a rule is set', () => {
    expect(composeAliasDisplayName('gpt-5.4', { reasoning: { effort: 'low' } })).toBe('gpt-5.4 (low effort)');
  });
});

describe('formatAliasRulesInline', () => {
  test('returns empty string when no rule is set', () => {
    expect(formatAliasRulesInline({})).toBe('');
  });

  test('joins configured parts in the canonical order', () => {
    expect(formatAliasRulesInline({
      reasoning: { effort: 'high' },
      verbosity: 'low',
      serviceTier: 'priority',
    })).toBe('high effort, low verbosity, priority tier');
  });

  test('renders boolean reasoning toggles in their dedicated wording', () => {
    expect(formatAliasRulesInline({
      reasoning: { adaptive: false, mandatory: true, summary: 'concise' },
    })).toBe('non-adaptive, mandatory reasoning, summary: concise');
  });

  test('emits adaptive when reasoning.adaptive is true and budget_tokens when set', () => {
    expect(formatAliasRulesInline({
      reasoning: { budget_tokens: 4096, adaptive: true },
    })).toBe('4096tok budget, adaptive');
  });
});

describe('formatAliasRuleBadges', () => {
  test('returns one badge per configured part in the canonical order', () => {
    expect(formatAliasRuleBadges({
      reasoning: { effort: 'high', budget_tokens: 2048 },
      verbosity: 'medium',
    })).toEqual([
      { label: 'high effort' },
      { label: '2048tok budget' },
      { label: 'medium verbosity' },
    ]);
  });

  test('returns an empty array when no rule is set', () => {
    expect(formatAliasRuleBadges({})).toEqual([]);
  });
});
