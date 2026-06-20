import { getRepo } from './repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from './repo/responses-payload.ts';
import { getDumpStore } from './runtime/dump.ts';
import { getImageCacheStore } from '@floway-dev/platform';

// Read only by this scheduled cleanup (deleteOlderThan). Lookups never filter
// by it — a row stays referenceable until cleanup removes it.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;

export const runScheduledMaintenance = async (): Promise<void> => {
  const now = startOfUtcHour(Date.now());
  await getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS);
  await sweepExpiredResponsesItemPayloadFiles(now);
  await getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
  await getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS);
  await getRepo().codexPkcePending.sweepExpired(Date.now());
  await getImageCacheStore().sweepExpired(Date.now());
  await sweepExpiredDumps();
};

// Per-key dump sweep: enumerate every key with retention enabled and let the
// store evict whatever is past its window. Each call is idempotent so a
// missed cron run is fully recovered on the next tick.
const sweepExpiredDumps = async (): Promise<void> => {
  const store = getDumpStore();
  for (const key of await getRepo().apiKeys.list()) {
    if (key.dumpRetentionSeconds === null) continue;
    try {
      await store.purgeExpired(key.id, key.dumpRetentionSeconds);
    } catch (err) {
      // One key's sweep failure must not abort the rest — log and move on.
      console.error('[scheduled] dump sweep failed', key.id, err);
    }
  }
};
