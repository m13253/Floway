import { InProcessDumpBroker } from './dump/broker.ts';
import { createNodeDumpStore } from './dump/store.ts';
import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCache } from './sqlite-image-cache.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { setDumpBroker, setDumpStore } from '@floway-dev/gateway';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  IMAGE_CACHE_POLICY,
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
}

// Trust set is seeded here, before any data-plane request can fire a
// userspace-TLS handshake.
export const bootstrapNodePlatform = (
  opts: NodePlatformOptions,
): { db: SqlDatabase } => {
  initEnv(name => process.env[name] ?? '');
  initRuntimeKind('node');
  const files = new FsFileProvider(opts.filesDir);
  initFileProvider(files);
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(opts.dbPath);
  initImageCacheStore(new SqliteImageCache(db, IMAGE_CACHE_POLICY));
  initImageProcessor(createSharpImageProcessor());
  // Dumps live in the same filesystem provider as every other spilled file.
  // Their `dumps/v1/{keyId}/...` key prefix keeps them isolated from the
  // other tenants (responses-item payloads, image cache) without needing a
  // second FileProvider.
  setDumpStore(createNodeDumpStore(db, files));
  setDumpBroker(new InProcessDumpBroker());
  return { db };
};
