import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase, type NodeSqliteDatabaseHandle } from './node-sqlite-database.ts';
import { createMemoryImageCache, createSharpImageProcessor } from './sharp-image-processor.ts';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  type ImageCache,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
  imageCache?: ImageCache;
}

// Wires the Node-specific platform implementations and returns the database
// handle so the caller can run migrations before constructing the repo.
// `imageCache` is optional: a single-process Node deployment gets an in-memory
// LRU by default, but a multi-instance deployment can pass a shared
// implementation (e.g. backed by Redis) without touching this code.
export const bootstrapNodePlatform = (
  opts: NodePlatformOptions,
): { db: NodeSqliteDatabaseHandle } => {
  // Ensure parent directories exist before sqlite tries to open the file and
  // before FsFileProvider writes its first object — `node:sqlite` returns
  // ERR_SQLITE_ERROR ("unable to open database file") when the parent is
  // missing, which is unhelpful to a fresh deploy.
  mkdirSync(dirname(opts.dbPath), { recursive: true });
  mkdirSync(opts.filesDir, { recursive: true });

  initEnv(name => process.env[name] ?? '');
  initFileProvider(new FsFileProvider(opts.filesDir));
  initImageProcessor(createSharpImageProcessor({ cache: opts.imageCache ?? createMemoryImageCache() }));
  return { db: createNodeSqliteDatabase(opts.dbPath) };
};
