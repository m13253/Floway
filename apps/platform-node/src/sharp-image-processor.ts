import sharp from 'sharp';

import { sha256Hex } from '@floway-dev/platform';
import type { ImageCache, ImageDimensions, ImageProcessor } from '@floway-dev/platform';

// Fixed WebP quality matching the Cloudflare encoder so both deployment
// targets pass the same lossy budget through to the upstream model. See
// platform-cloudflare/src/image-processor.ts for the calibration notes.
const WEBP_QUALITY = 82;

const CACHE_KEY_PREFIX = 'imgwebp';
const CACHE_TTL_SECONDS = 30 * 24 * 60 * 60;

class SharpImageProcessor implements ImageProcessor {
  constructor(private readonly cache: ImageCache | null) {}

  async compressToWebp(input: Uint8Array, target: ImageDimensions | null): Promise<Uint8Array> {
    let cacheKey: string | null = null;
    if (this.cache) {
      const targetKey = target ? `${target.width}x${target.height}` : 'orig';
      cacheKey = `${CACHE_KEY_PREFIX}:${await sha256Hex(input)}:${targetKey}:webp:q${WEBP_QUALITY}`;
      const hit = await this.cache.get(cacheKey);
      if (hit) return hit;
    }

    let pipeline = sharp(input);
    if (target) {
      // `inside` matches scale-down semantics: never enlarges, preserves aspect
      // ratio, fits inside the target box. `withoutEnlargement` makes the
      // never-enlarge guarantee explicit even when callers ask for a target
      // larger than the source.
      pipeline = pipeline.resize({
        width: target.width,
        height: target.height,
        fit: 'inside',
        withoutEnlargement: true,
      });
    }
    const output = new Uint8Array(await pipeline.webp({ quality: WEBP_QUALITY }).toBuffer());

    if (this.cache && cacheKey) await this.cache.put(cacheKey, output, CACHE_TTL_SECONDS);
    return output;
  }
}

export const createSharpImageProcessor = (opts: { cache?: ImageCache } = {}): ImageProcessor =>
  new SharpImageProcessor(opts.cache ?? null);

// Bounded in-memory ImageCache. Eviction is FIFO on size, which is enough for
// a single-process Node deployment where the cache exists to absorb repeated
// images within one conversation; a long-lived deployment that wants smarter
// eviction can pass its own ImageCache implementation to bootstrap.
export const createMemoryImageCache = (maxEntries = 64): ImageCache => {
  const store = new Map<string, Uint8Array>();
  return {
    get(key) {
      return Promise.resolve(store.get(key) ?? null);
    },
    put(key, value) {
      if (!store.has(key) && store.size >= maxEntries) {
        const firstKey = store.keys().next().value;
        if (firstKey !== undefined) store.delete(firstKey);
      }
      store.set(key, value);
      return Promise.resolve();
    },
  };
};
