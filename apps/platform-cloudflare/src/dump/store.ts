import { R2FileProvider, type R2BucketLike } from '../r2-file-provider.ts';
import { FileDumpStore } from '@floway-dev/gateway';
import type { DumpStore, SqlDatabase } from '@floway-dev/platform';

// Cloudflare DumpStore: thin wrapper that pairs the existing R2FileProvider
// against the dedicated DUMP_BLOBS bucket. The actual gzip + descriptor +
// row layout lives in the runtime-agnostic FileDumpStore so the Node target
// reuses every byte of it.
export const createCloudflareDumpStore = (db: SqlDatabase, bucket: R2BucketLike): DumpStore =>
  new FileDumpStore(db, new R2FileProvider(bucket));
