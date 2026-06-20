import { FileDumpStore } from '@floway-dev/gateway';
import type { DumpStore, FileProvider, SqlDatabase } from '@floway-dev/platform';

// Node DumpStore: same FileDumpStore the Cloudflare runtime uses, paired
// with the Node FileProvider already wired into the platform singleton.
// Kept as a one-line factory for symmetry with the Cloudflare side; the
// real work lives in the gateway-core impl.
export const createNodeDumpStore = (db: SqlDatabase, files: FileProvider): DumpStore =>
  new FileDumpStore(db, files);
