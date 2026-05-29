import { test } from 'vitest';

import { createCloudflareImageProcessor, type ImagesBinding } from './cloudflare.ts';
import { defaultImageSizeCalculator } from './size.ts';
import { assert, assertEquals } from '../test-assert.ts';

const streamOf = (bytes: Uint8Array): ReadableStream =>
  new ReadableStream({
    start(controller) {
      controller.enqueue(bytes);
      controller.close();
    },
  });

interface TransformCall {
  width?: number;
  height?: number;
  fit?: string;
}

interface OutputCall {
  format: string;
  quality?: number;
}

const recordingBinding = (result: Uint8Array): { binding: ImagesBinding; transforms: TransformCall[]; outputs: OutputCall[] } => {
  const transforms: TransformCall[] = [];
  const outputs: OutputCall[] = [];
  const binding: ImagesBinding = {
    input() {
      const transformer = {
        transform(options: TransformCall) {
          transforms.push(options);
          return transformer;
        },
        output(options: OutputCall) {
          outputs.push(options);
          return Promise.resolve({ image: () => streamOf(result) });
        },
      };
      return transformer;
    },
  };
  return { binding, transforms, outputs };
};

const png = (width: number, height: number): Uint8Array => {
  const bytes = new Uint8Array(24);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
  bytes.set([0x49, 0x48, 0x44, 0x52], 12);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return bytes;
};

test('compresses to WebP at the fixed quality, resizing within the calculator box', async () => {
  const { binding, transforms, outputs } = recordingBinding(new Uint8Array([9, 9, 9]));
  const processor = createCloudflareImageProcessor(binding);

  const output = await processor.compressToWebp(png(4000, 2000), defaultImageSizeCalculator);

  // 4000px long edge scales down to the 1568 cap; aspect ratio preserved.
  assertEquals(transforms, [{ width: 1568, height: 784, fit: 'scale-down' }]);
  assertEquals(outputs, [{ format: 'image/webp', quality: 82 }]);
  assertEquals([...output], [9, 9, 9]);
});

test('re-encodes without a resize when dimensions cannot be read', async () => {
  const { binding, transforms, outputs } = recordingBinding(new Uint8Array([1]));
  const processor = createCloudflareImageProcessor(binding);

  await processor.compressToWebp(new Uint8Array([1, 2, 3, 4]), defaultImageSizeCalculator);

  assert(transforms.length === 0);
  assertEquals(outputs, [{ format: 'image/webp', quality: 82 }]);
});

test('leaves images already within the cap unscaled', async () => {
  const { binding, transforms } = recordingBinding(new Uint8Array([0]));
  const processor = createCloudflareImageProcessor(binding);

  await processor.compressToWebp(png(800, 600), defaultImageSizeCalculator);

  assertEquals(transforms, [{ width: 800, height: 600, fit: 'scale-down' }]);
});
