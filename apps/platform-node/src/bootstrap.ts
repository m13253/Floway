import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createMemoryImageCache, createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { nodeRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  initSocketDial,
  type ImageCache,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
  imageCache?: ImageCache;
}

// `imageCache` is optional: a single-process Node deployment gets an
// in-memory LRU by default, but a multi-instance deployment can pass a
// shared implementation (e.g. backed by Redis) without touching this code.
//
// Trust set is seeded here, before any data-plane request can fire a
// userspace-TLS handshake — the Node runtime's bundled CA list plus
// anything Node folded in from NODE_EXTRA_CA_CERTS. `addTrustedRootCAs`
// documents the underlying freeze-on-first-handshake constraint.
export const bootstrapNodePlatform = (opts: NodePlatformOptions): { db: SqlDatabase } => {
  initEnv(name => process.env[name] ?? '');
  initFileProvider(new FsFileProvider(opts.filesDir));
  initImageProcessor(createSharpImageProcessor({ cache: opts.imageCache ?? createMemoryImageCache() }));
  initSocketDial(nodeSocketDial);
  addTrustedRootCAs(nodeRuntimeRootCAs);
  return { db: createNodeSqliteDatabase(opts.dbPath) };
};
