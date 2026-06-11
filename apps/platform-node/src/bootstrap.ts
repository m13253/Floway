import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createMemoryImageCache, createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCache } from './sqlite-image-cache.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
}

// Trust set is seeded here, before any data-plane request can fire a
// userspace-TLS handshake.
export const bootstrapNodePlatform = (opts: NodePlatformOptions): { db: SqlDatabase } => {
  initEnv(name => process.env[name] ?? '');
  initFileProvider(new FsFileProvider(opts.filesDir));
  initImageProcessor(createSharpImageProcessor({ cache: createMemoryImageCache() }));
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(opts.dbPath);
  initImageCacheStore(new SqliteImageCache(db));
  return { db };
};
