import type { DumpStore } from '@floway-dev/platform';

export interface DumpPurgeKey {
  id: string;
  dumpRetentionSeconds: number | null;
}

export const purgeDumpsForAllKeys = async (
  store: DumpStore,
  keys: Iterable<DumpPurgeKey>,
): Promise<void> => {
  for (const key of keys) {
    if (key.dumpRetentionSeconds === null) continue;
    await store.purgeExpired(key.id, key.dumpRetentionSeconds);
  }
};
