import { describe, expect, test } from 'vitest';

import { pricingForClaudeCodeModelKey } from './pricing.ts';

describe('pricingForClaudeCodeModelKey', () => {
  test('returns the documented per-million-token rates for each dated id', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-4-5-20250929')).toEqual({
      input: 3,
      input_cache_read: 0.3,
      input_cache_write: 3.75,
      output: 15,
    });
    expect(pricingForClaudeCodeModelKey('claude-opus-4-5-20251101')).toEqual({
      input: 15,
      input_cache_read: 1.5,
      input_cache_write: 18.75,
      output: 75,
    });
    expect(pricingForClaudeCodeModelKey('claude-haiku-4-5-20251001')).toEqual({
      input: 1,
      input_cache_read: 0.1,
      input_cache_write: 1.25,
      output: 5,
    });
  });

  test('returns null for unknown / future dated ids (forward-compat)', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-5-0-20270101')).toBeNull();
  });

  test('returns null for the bare alias — only dated ids carry pricing', () => {
    expect(pricingForClaudeCodeModelKey('claude-sonnet-4-5')).toBeNull();
  });
});
