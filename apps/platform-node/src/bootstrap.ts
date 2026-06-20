import { InProcessDumpBroker } from './dump/broker.ts';
import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCache } from './sqlite-image-cache.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  getEnvOptional,
  IMAGE_CACHE_POLICY,
  initEnv,
  initFileProvider,
  initImageCacheStore,
  initImageProcessor,
  initRuntimeKind,
  initSocketDial,
  type SqlDatabase,
} from '@floway-dev/platform';

// Bootstraps `initEnv` against `process.env` first so every subsequent read
// — including the runtime paths below — routes through the same contract as
// every other env consumer (auth, performance telemetry, etc).
export const bootstrapNodePlatform = (): { db: SqlDatabase } => {
  initEnv(name => process.env[name]);
  initRuntimeKind('node');

  const filesDir = getEnvOptional('FLOWAY_FILES_DIR', './data/files');
  const dbPath = getEnvOptional('FLOWAY_DB_PATH', './data/floway.db');

  const files = new FsFileProvider(filesDir);
  initFileProvider(files);
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  const db = createNodeSqliteDatabase(dbPath);
  initImageCacheStore(new SqliteImageCache(db, IMAGE_CACHE_POLICY));
  initImageProcessor(createSharpImageProcessor());
  // Dumps live in the same filesystem provider as every other spilled file.
  // Their `dumps/v1/{keyId}/...` key prefix keeps them isolated from the
  // other tenants (responses-item payloads, image cache) without needing a
  // second FileProvider.
  initDumpStore(new FileDumpStore(db, files));
  initDumpBroker(new InProcessDumpBroker());
  return { db };
};
