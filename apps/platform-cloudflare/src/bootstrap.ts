
import type { D1Database } from './d1-types.ts';
import { createCloudflareImageProcessor, type ImagesBinding, type KvNamespace } from './image-processor.ts';
import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  type ImageCache,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: D1Database;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  KV: KvNamespace;
  [key: string]: unknown;
}

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 holds spilled payloads, Images compresses inline
// images, KV memoises compressed results. A missing binding means
// wrangler.jsonc drifted from the code, so we refuse to initialise rather
// than 503 on first use of the absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'KV'] as const;

const cloudflareKvImageCache = (kv: KvNamespace): ImageCache => ({
  get: async key => {
    const buf = await kv.get(key, 'arrayBuffer');
    return buf ? new Uint8Array(buf) : null;
  },
  put: (key, value, ttlSeconds) => kv.put(key, value, { expirationTtl: ttlSeconds }),
});

export const bootstrapCloudflarePlatform = (env: CloudflareEnv): { db: SqlDatabase } => {
  const missing = REQUIRED_BINDINGS.filter(name => env[name] === undefined || env[name] === null);
  if (missing.length > 0) {
    throw new Error(
      `Missing required Cloudflare bindings: ${missing.join(', ')}. `
      + 'Declare them in wrangler.jsonc; see wrangler.example.jsonc.',
    );
  }

  initEnv(name => String(env[name] ?? ''));
  initFileProvider(new R2FileProvider(env.FILES));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES, cloudflareKvImageCache(env.KV)));
  return { db: env.DB };
};
