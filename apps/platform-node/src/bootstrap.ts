import { EventTargetChannelBroker } from './event-target-channel-broker.ts';
import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { SqliteImageCache } from './sqlite-image-cache.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { FileDumpStore, initDumpBroker, initDumpStore } from '@floway-dev/gateway';
import { dumpCodec } from '@floway-dev/gateway/dump';
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
import type { DumpMetadata } from '@floway-dev/protocols/dump';

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
  // FileDumpStore shares the FS provider; its own prefix scheme keeps spilled
  // bodies isolated from other writers.
  initDumpStore(new FileDumpStore(db, files));
  initDumpBroker(new EventTargetChannelBroker<DumpMetadata>(dumpCodec));
  return { db };
};
