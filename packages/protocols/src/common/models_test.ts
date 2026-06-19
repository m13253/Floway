import { test } from 'vitest';

import { resolveEffectivePricing, unitPriceForDimension, type ModelPricing } from './models.ts';
import { assertEquals } from '../test-assert.ts';

test('unitPriceForDimension input_cache_write_1h falls back 1h → 5m → input', () => {
  const explicit: ModelPricing = { input: 5, input_cache_write: 6.25, input_cache_write_1h: 10 };
  assertEquals(unitPriceForDimension(explicit, 'input_cache_write_1h'), 10);

  const onlyFiveMinute: ModelPricing = { input: 5, input_cache_write: 6.25 };
  assertEquals(unitPriceForDimension(onlyFiveMinute, 'input_cache_write_1h'), 6.25);

  const onlyInput: ModelPricing = { input: 5 };
  assertEquals(unitPriceForDimension(onlyInput, 'input_cache_write_1h'), 5);

  assertEquals(unitPriceForDimension({}, 'input_cache_write_1h'), null);
  assertEquals(unitPriceForDimension(null, 'input_cache_write_1h'), null);
});

test('resolveEffectivePricing merges a tier override into the base snapshot and strips tiers', () => {
  const base: ModelPricing = {
    input: 5,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    input_cache_write_1h: 10,
    output: 25,
    tiers: { fast: { input: 30, output: 150, input_cache_write_1h: 60 } },
  };
  const effective = resolveEffectivePricing(base, 'fast');
  assertEquals(effective, {
    input: 30,
    input_cache_read: 0.5,
    input_cache_write: 6.25,
    input_cache_write_1h: 60,
    output: 150,
  });
});

test('resolveEffectivePricing returns the base snapshot (sans tiers) when tier is unknown or absent', () => {
  const base: ModelPricing = {
    input: 5,
    output: 25,
    tiers: { fast: { input: 30 } },
  };
  const expected: ModelPricing = { input: 5, output: 25 };

  assertEquals(resolveEffectivePricing(base, null), expected);
  assertEquals(resolveEffectivePricing(base, undefined), expected);
  assertEquals(resolveEffectivePricing(base, 'priority'), expected);
});

test('resolveEffectivePricing returns null when the base snapshot is null', () => {
  assertEquals(resolveEffectivePricing(null, 'fast'), null);
  assertEquals(resolveEffectivePricing(null, null), null);
});
