import { describe, expect, test } from 'vitest';

import { CLAUDE_CODE_MODELS } from './models.ts';

describe('CLAUDE_CODE_MODELS catalog', () => {
  test('ships exactly three dated ids — sonnet / opus / haiku', () => {
    expect(CLAUDE_CODE_MODELS.map(m => m.id)).toEqual([
      'claude-sonnet-4-5-20250929',
      'claude-opus-4-5-20251101',
      'claude-haiku-4-5-20251001',
    ]);
  });

  test('every model advertises only the messages endpoint and chat kind', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect(m.endpoints).toEqual({ messages: {} });
      expect(m.kind).toBe('chat');
      expect(m.owned_by).toBe('anthropic');
    }
  });

  test('every model has non-null pricing pulled from the pricing table', () => {
    for (const m of CLAUDE_CODE_MODELS) {
      expect(m.cost).toBeDefined();
      expect(typeof m.cost!.input).toBe('number');
      expect(typeof m.cost!.output).toBe('number');
    }
  });

  test('sonnet carries the 1M context-window upper bound', () => {
    const sonnet = CLAUDE_CODE_MODELS[0]!;
    expect(sonnet.limits.max_context_window_tokens).toBe(1_000_000);
  });
});
