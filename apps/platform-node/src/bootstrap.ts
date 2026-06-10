import { FsFileProvider } from './fs-file-provider.ts';
import { createNodeSqliteDatabase } from './node-sqlite-database.ts';
import { createMemoryImageCache, createSharpImageProcessor } from './sharp-image-processor.ts';
import { nodeSocketDial } from './socket-dial.ts';
import { nodeGetRuntimeRootCAs } from './tls-trust.ts';
import { addTrustedRootCAs } from '@floway-dev/http';
import {
  initEnv,
  initFileProvider,
  initImageProcessor,
  initRuntimeRootCAs,
  initSocketDial,
  type ImageCache,
  type SqlDatabase,
} from '@floway-dev/platform';

export interface NodePlatformOptions {
  dbPath: string;
  filesDir: string;
  imageCache?: ImageCache;
}

// Wires the Node-specific platform implementations. Each component
// (createNodeSqliteDatabase, FsFileProvider) ensures its own root directory
// exists, so bootstrap stays a pure wiring step. `imageCache` is optional:
// a single-process Node deployment gets an in-memory LRU by default, but a
// multi-instance deployment can pass a shared implementation (e.g. backed
// by Redis) without touching this code.
//
// Trust set is seeded here, before any data-plane request can fire a
// userspace-TLS handshake: `@reclaimprotocol/tls`'s root-CA cache is built
// on first handshake and frozen thereafter, so the Node runtime's bundled
// CA list (plus anything Node folded in from NODE_EXTRA_CA_CERTS) must
// land in `globalThis.TLS_ADDITIONAL_ROOT_CA_LIST` before then.
export const bootstrapNodePlatform = (opts: NodePlatformOptions): { db: SqlDatabase } => {
  initEnv(name => process.env[name] ?? '');
  initFileProvider(new FsFileProvider(opts.filesDir));
  initImageProcessor(createSharpImageProcessor({ cache: opts.imageCache ?? createMemoryImageCache() }));
  initSocketDial(nodeSocketDial);
  initRuntimeRootCAs(nodeGetRuntimeRootCAs);
  const runtimeCAs = nodeGetRuntimeRootCAs();
  if (runtimeCAs) addTrustedRootCAs(runtimeCAs);
  return { db: createNodeSqliteDatabase(opts.dbPath) };
};
