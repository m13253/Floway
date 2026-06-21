import { test } from 'vitest';

import { unitPriceForDimension } from './models.ts';
import { assertEquals } from '../test-assert.ts';

test('unitPriceForDimension returns null when pricing snapshot is null', () => {
  assertEquals(unitPriceForDimension(null, 'input'), null);
  assertEquals(unitPriceForDimension(null, 'input_cache_write_1h'), null);
});

test('unitPriceForDimension prefers the dimension-specific rate', () => {
  const pricing = { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, input_cache_write_1h: 2, output: 5 };
  assertEquals(unitPriceForDimension(pricing, 'input'), 1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_read'), 0.1);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write'), 1.25);
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 2);
  assertEquals(unitPriceForDimension(pricing, 'output'), 5);
});

test('unitPriceForDimension falls input_cache_write_1h back to input_cache_write before reaching input', () => {
  // 1h -> 5m -> input. When only 5m is defined, 1h reuses the 5m rate
  // rather than skipping straight to the bare input rate.
  const pricing = { input: 1, input_cache_write: 1.25 };
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 1.25);
});

test('unitPriceForDimension falls input_cache_write_1h all the way back to input when neither cache write is set', () => {
  const pricing = { input: 1 };
  assertEquals(unitPriceForDimension(pricing, 'input_cache_write_1h'), 1);
});

test('unitPriceForDimension returns null when the fallback chain is empty', () => {
  assertEquals(unitPriceForDimension({}, 'input_cache_write_1h'), null);
  assertEquals(unitPriceForDimension({ output: 5 }, 'input_cache_write_1h'), null);
});
