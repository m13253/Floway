import { describe, expect, test } from 'vitest';

import { chatField, modelsField, pricingField } from './model-config.ts';
import { assertEquals, assertThrows } from '@floway-dev/test-utils';

test('pricingField parses bare dimensions and drops empty objects', () => {
  assertEquals(pricingField(undefined, 'cost'), undefined);
  assertEquals(pricingField({}, 'cost'), undefined);
  assertEquals(
    pricingField({ input: 5, output: 25, input_cache_read: 0.5 }, 'cost'),
    { input: 5, output: 25, input_cache_read: 0.5 },
  );
});

test('pricingField parses per-tier overlays alongside base rates', () => {
  const result = pricingField(
    {
      input: 5,
      output: 25,
      tiers: {
        fast: { input: 30, output: 150 },
        flex: { input: 2.5 },
      },
    },
    'cost',
  );
  assertEquals(result, {
    input: 5,
    output: 25,
    tiers: {
      fast: { input: 30, output: 150 },
      flex: { input: 2.5 },
    },
  });
});

test('pricingField drops empty tier overlays and skips unknown keys inside them', () => {
  const result = pricingField(
    {
      input: 5,
      tiers: {
        fast: { input: 30, bogus_key: 99 },
        priority: {},
      },
    },
    'cost',
  );
  assertEquals(result, { input: 5, tiers: { fast: { input: 30 } } });
});

test('pricingField rejects non-object tiers, empty names, and negative rates', () => {
  assertThrows(() => pricingField({ tiers: 'nope' }, 'cost'), Error, 'tiers');
  assertThrows(() => pricingField({ tiers: { '': { input: 5 } } }, 'cost'), Error, 'tier name');
  assertThrows(() => pricingField({ tiers: { fast: 1 } }, 'cost'), Error, 'tiers.fast');
  assertThrows(() => pricingField({ tiers: { fast: { input: -1 } } }, 'cost'), Error, 'non-negative');
});

describe('chatField', () => {
  test('returns undefined when value is undefined', () => {
    expect(chatField(undefined, 'm.chat')).toBeUndefined();
  });

  test('parses a full chat block', () => {
    const chat = chatField({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium' },
    }, 'm.chat');
    expect(chat).toEqual({
      modalities: { input: ['text', 'image'], output: ['text'] },
      reasoning: { supported_efforts: ['low', 'medium', 'high'], default_effort: 'medium' },
    });
  });

  test('rejects unknown modality value', () => {
    expect(() => chatField({ modalities: { input: ['video'], output: ['text'] } }, 'm.chat'))
      .toThrow(/modalities\.input/);
  });

  test('rejects modalities missing text', () => {
    expect(() => chatField({ modalities: { input: ['image'], output: ['text'] } }, 'm.chat'))
      .toThrow(/must include 'text'/);
  });

  test('deduplicates modality entries', () => {
    const chat = chatField({ modalities: { input: ['text', 'text', 'image'], output: ['text'] } }, 'm.chat');
    expect(chat?.modalities?.input).toEqual(['text', 'image']);
  });

  test('rejects empty reasoning effort string', () => {
    expect(() => chatField({ reasoning: { supported_efforts: ['low', ''], default_effort: 'low' } }, 'm.chat'))
      .toThrow(/supported_efforts/);
  });

  test('rejects default_effort not in supported_efforts', () => {
    expect(() => chatField({ reasoning: { supported_efforts: ['low', 'high'], default_effort: 'medium' } }, 'm.chat'))
      .toThrow(/default_effort/);
  });

  test('rejects reasoning without default_effort', () => {
    expect(() => chatField({ reasoning: { supported_efforts: ['low'] } }, 'm.chat'))
      .toThrow(/default_effort/);
  });

  test('returns empty object (not undefined) for empty chat block', () => {
    expect(chatField({}, 'm.chat')).toEqual({});
  });

  test('accepts image-only output modalities', () => {
    const chat = chatField({ modalities: { input: ['text'], output: ['image'] } }, 'm.chat');
    expect(chat?.modalities?.output).toEqual(['image']);
  });

  test('rejects empty output modalities array', () => {
    expect(() => chatField({ modalities: { input: ['text'], output: [] } }, 'm.chat'))
      .toThrow(/at least one modality/);
  });
});

describe('modelsField chat integration', () => {
  test('rejects chat on non-chat kind', () => {
    expect(() => modelsField([{
      upstreamModelId: 'm',
      kind: 'embedding',
      endpoints: { embeddings: {} },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }], 'p')).toThrow(/chat .* only allowed when kind/);
  });

  test('accepts chat on chat kind', () => {
    const [m] = modelsField([{
      upstreamModelId: 'm',
      kind: 'chat',
      endpoints: { chatCompletions: {} },
      chat: { modalities: { input: ['text'], output: ['text'] } },
    }], 'p');
    expect(m.chat?.modalities?.input).toEqual(['text']);
  });
});
