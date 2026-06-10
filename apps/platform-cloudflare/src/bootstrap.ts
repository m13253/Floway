import { cloudflareKvImageCache, createCloudflareImageProcessor, type ImagesBinding, type KvNamespace } from './image-processor.ts';
import { R2FileProvider, type R2BucketLike } from './r2-file-provider.ts';
import { cloudflareSocketDial } from './socket-dial.ts';
import { cloudflareGetRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  initRuntimeRootCAs,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface CloudflareEnv {
  DB: SqlDatabase;
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
  initSocketDial(cloudflareSocketDial);
  initRuntimeRootCAs(cloudflareGetRuntimeRootCAs);
  // workerd surfaces no runtime trust store — the impl returns null and we
  // fall back to `@reclaimprotocol/tls`'s bundled Mozilla snapshot.
  const runtimeCAs = cloudflareGetRuntimeRootCAs();
  if (runtimeCAs) addTrustedRootCAs(runtimeCAs);
  return { db: env.DB };
};
