import { test } from 'vitest';

import { pricingField } from './model-config.ts';
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
