import type { DumpStore } from '@floway-dev/platform';

export interface DumpPurgeKey {
  id: string;
  dumpRetentionSeconds: number | null;
}

// Per-key try/catch keeps a single broken key (storage hiccup, file
// permission issue, corrupt row) from skipping every later key in the
// sweep. The keyId is in the log line so the operator can correlate the
// failure with the offending key.
export const purgeDumpsForAllKeys = async (
  store: DumpStore,
  keys: Iterable<DumpPurgeKey>,
): Promise<void> => {
  for (const key of keys) {
    if (key.dumpRetentionSeconds === null) continue;
    try {
      await store.purgeExpired(key.id, key.dumpRetentionSeconds);
    } catch (err) {
      console.error('[dump-purge]', key.id, err);
    }
  }
};
