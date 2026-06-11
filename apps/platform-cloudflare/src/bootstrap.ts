import { cloudflareKvImageCache, createCloudflareImageProcessor, type ImagesBinding, type KvNamespace } from './image-processor.ts';
import { KvImageCache } from './kv-image-cache.ts';
import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { cloudflareRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: SqlDatabase;
  FILES: R2BucketLike;
  IMAGES: ImagesBinding;
  IMAGE_CACHE: KvNamespace;
  KV: KvNamespace;
  [key: string]: unknown;
}

// Every binding declared on `CloudflareEnv` is load-bearing — D1 holds all
// config and telemetry, R2 holds spilled payloads, Images compresses inline
// images, IMAGE_CACHE memoises compressed image results, KV memoises
// compressed results (legacy; image-processor will switch to IMAGE_CACHE in
// a follow-up). A missing binding means wrangler.jsonc drifted from the
// code, so we refuse to initialise rather than 503 on first use of the
// absent binding.
const REQUIRED_BINDINGS = ['DB', 'FILES', 'IMAGES', 'IMAGE_CACHE', 'KV'] as const;

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
  initImageCacheStore(new KvImageCache(env.IMAGE_CACHE));
  initImageProcessor(createCloudflareImageProcessor(env.IMAGES, cloudflareKvImageCache(env.KV)));
  initSocketDial(cloudflareSocketDial);
  addTrustedRootCAs(cloudflareRuntimeRootCAs);
  return { db: env.DB };
};
