import { test } from 'vitest';

import { fitWithin } from './size.ts';
import { assertEquals } from '../test-assert.ts';

test('fitWithin returns the source unchanged when within every cap', () => {
  assertEquals(fitWithin({ width: 800, height: 600 }, { maxLongEdge: 2048, maxArea: 2_560_000 }), { width: 800, height: 600 });
});

test('fitWithin never upscales', () => {
  assertEquals(fitWithin({ width: 100, height: 100 }, { maxLongEdge: 2048 }), { width: 100, height: 100 });
});

test('fitWithin clamps the long edge preserving aspect ratio', () => {
  assertEquals(fitWithin({ width: 4000, height: 2000 }, { maxLongEdge: 2048 }), { width: 2048, height: 1024 });
});

test('fitWithin clamps the short edge', () => {
  // 1374x1145 short edge 1145 -> 768; long edge scales by 768/1145.
  assertEquals(fitWithin({ width: 1374, height: 1145 }, { maxLongEdge: 2048, maxShortEdge: 768 }), { width: 922, height: 768 });
});

test('fitWithin clamps by area preserving aspect ratio', () => {
  // 2000x2000 = 4MP -> sqrt(2_560_000/4_000_000)=0.8 -> 1600x1600.
  assertEquals(fitWithin({ width: 2000, height: 2000 }, { maxArea: 2_560_000 }), { width: 1600, height: 1600 });
});

test('fitWithin applies the tightest cap when several bind (8000x2000 tile sampling)', () => {
  // long 2048 -> 0.256; short 768/2000 -> 0.384; min -> 0.256 -> 2048x512.
  assertEquals(fitWithin({ width: 8000, height: 2000 }, { maxLongEdge: 2048, maxShortEdge: 768 }), { width: 2048, height: 512 });
});
