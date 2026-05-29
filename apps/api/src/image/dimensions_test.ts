import { test } from 'vitest';

import { readImageDimensions } from './dimensions.ts';
import { assert, assertEquals } from '../test-assert.ts';

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
};

const gif = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(13);
  bytes.set([0x47, 0x49, 0x46, 0x38, 0x39, 0x61], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(6, width, true);
  view.setUint16(8, height, true);
  return bytes;
};

const jpeg = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(13);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0x00, 0x11, 0x08], 0);
  const view = new DataView(bytes.buffer);
  view.setUint16(7, height);
  view.setUint16(9, width);
  return bytes;
};

const webpVp8x = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(30);
  bytes.set([0x52, 0x49, 0x46, 0x46], 0);
  bytes.set([0x57, 0x45, 0x42, 0x50], 8);
  bytes.set([0x56, 0x50, 0x38, 0x58], 12);
  const w = width - 1;
  const h = height - 1;
  bytes.set([w & 0xff, (w >> 8) & 0xff, (w >> 16) & 0xff], 24);
  bytes.set([h & 0xff, (h >> 8) & 0xff, (h >> 16) & 0xff], 27);
  return bytes;
};

test('reads PNG dimensions from the IHDR header', () => {
  assertEquals(readImageDimensions(png(800, 600)), { width: 800, height: 600 });
});

test('reads GIF dimensions from the logical screen descriptor', () => {
  assertEquals(readImageDimensions(gif(1024, 768)), { width: 1024, height: 768 });
});

test('reads JPEG dimensions from the SOF0 marker', () => {
  assertEquals(readImageDimensions(jpeg(1920, 1080)), { width: 1920, height: 1080 });
});

test('reads extended WebP (VP8X) canvas dimensions', () => {
  assertEquals(readImageDimensions(webpVp8x(2000, 1500)), { width: 2000, height: 1500 });
});

test('returns null for unrecognised bytes', () => {
  assert(readImageDimensions(new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8])) === null);
});
