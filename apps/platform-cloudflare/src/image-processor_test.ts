import { test } from 'vitest';

import { createCloudflareImageProcessor, type ImagesBinding } from './image-processor.ts';
import type { ImageCacheStore, ImageDimensions } from '@floway-dev/platform';
import { initImageCacheStore } from '@floway-dev/platform';
import { assert, assertEquals } from '@floway-dev/test-utils';

const decode = (base64: string): Uint8Array => {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
  return bytes;
};

const PNG_1x1 = decode('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M8AAAMBAQDJ/wEAAAAASUVORK5CYII=');

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

const recordingImages = (result: Uint8Array): { binding: ImagesBinding; transforms: TransformCall[]; outputs: { format: string; quality?: number }[] } => {
  const transforms: TransformCall[] = [];
  const outputs: { format: string; quality?: number }[] = [];
  const binding: ImagesBinding = {
    input() {
      const transformer = {
        transform(options: TransformCall) {
          transforms.push(options);
          return transformer;
        },
        output(options: { format: string; quality?: number }) {
          outputs.push(options);
          return Promise.resolve({ image: () => streamOf(result) });
        },
      };
      return transformer;
    },
  };
  return { binding, transforms, outputs };
};

const installMemoryStore = (): { store: Map<string, Uint8Array>; ttls: number[]; refreshes: number[] } => {
  const store = new Map<string, Uint8Array>();
  const ttls: number[] = [];
  const refreshes: number[] = [];
  const cacheStore: ImageCacheStore = {
    get(key, refreshTtlMs) {
      const value = store.get(key);
      if (!value) return Promise.resolve(null);
      refreshes.push(refreshTtlMs);
      return Promise.resolve(value);
    },
    put(key, value, ttlMs) {
      ttls.push(ttlMs);
      store.set(key, value);
      return Promise.resolve();
    },
    sweepExpired() {
      return Promise.resolve();
    },
  };
  initImageCacheStore(cacheStore);
  return { store, ttls, refreshes };
};

const fixedTarget: ImageDimensions = { width: 50, height: 40 };

test('compresses to WebP at the fixed quality, resizing to the resolved target, then caches', async () => {
  const { binding, transforms, outputs } = recordingImages(new Uint8Array([9, 9, 9]));
  const { store, ttls } = installMemoryStore();
  const processor = createCloudflareImageProcessor(binding);

  const output = await processor.compressToWebp(PNG_1x1, fixedTarget);

  assertEquals(transforms, [{ width: 50, height: 40, fit: 'scale-down' }]);
  assertEquals(outputs, [{ format: 'image/webp', quality: 82 }]);
  assertEquals([...output], [9, 9, 9]);
  assertEquals(store.size, 1);
  assert([...store.keys()][0].includes(':50x40:webp:q82'));
  assertEquals(ttls, [24 * 60 * 60 * 1000]);
});

test('cache hit refreshes the entry TTL', async () => {
  const { binding } = recordingImages(new Uint8Array([5, 5, 5]));
  const { refreshes } = installMemoryStore();
  const processor = createCloudflareImageProcessor(binding);

  await processor.compressToWebp(PNG_1x1, fixedTarget);
  await processor.compressToWebp(PNG_1x1, fixedTarget);

  assertEquals(refreshes, [24 * 60 * 60 * 1000]);
});

test('serves a cache hit without calling the Images binding again', async () => {
  const { binding, transforms } = recordingImages(new Uint8Array([7, 7]));
  installMemoryStore();
  const processor = createCloudflareImageProcessor(binding);

  const first = await processor.compressToWebp(PNG_1x1, fixedTarget);
  const second = await processor.compressToWebp(PNG_1x1, fixedTarget);

  assertEquals([...first], [7, 7]);
  assertEquals([...second], [7, 7]);
  assertEquals(transforms.length, 1);
});

test('forwards the encoder without a resize when target is null', async () => {
  const { binding, transforms, outputs } = recordingImages(new Uint8Array([1]));
  installMemoryStore();
  const processor = createCloudflareImageProcessor(binding);

  await processor.compressToWebp(PNG_1x1, null);

  assertEquals(transforms.length, 0);
  assertEquals(outputs, [{ format: 'image/webp', quality: 82 }]);
});
