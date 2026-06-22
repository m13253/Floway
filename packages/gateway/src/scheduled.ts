import { getRepo } from './repo/index.ts';
import { RESPONSES_ITEM_PAYLOAD_TTL_MS, startOfUtcHour, sweepExpiredResponsesItemPayloadFiles } from './repo/responses-payload.ts';
import { getDumpStore } from './runtime/dump.ts';
import { getImageCacheStore } from '@floway-dev/platform';

// Read only by this scheduled cleanup (deleteOlderThan). Lookups never filter
// by it — a row stays referenceable until cleanup removes it.
const RESPONSES_ITEM_ROW_TTL_MS = 180 * 24 * 60 * 60 * 1000;

const runSweep = async (name: string, fn: () => Promise<unknown>): Promise<void> => {
  try {
    await fn();
  } catch (err) {
    console.error(`[scheduled] ${name} failed`, err);
  }
};

export const runScheduledMaintenance = async (): Promise<void> => {
  const now = startOfUtcHour(Date.now());
  await runSweep('responsesItems.clearPayloadOlderThan', () => getRepo().responsesItems.clearPayloadOlderThan(now - RESPONSES_ITEM_PAYLOAD_TTL_MS));
  await runSweep('responsesItems.sweepPayloadFiles', () => sweepExpiredResponsesItemPayloadFiles(now));
  await runSweep('responsesSnapshots.deleteOlderThan', () => getRepo().responsesSnapshots.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS));
  await runSweep('responsesItems.deleteOlderThan', () => getRepo().responsesItems.deleteOlderThan(now - RESPONSES_ITEM_ROW_TTL_MS));
  await runSweep('codexPkcePending.sweepExpired', () => getRepo().codexPkcePending.sweepExpired(Date.now()));
  await runSweep('imageCacheStore.sweepExpired', () => getImageCacheStore().sweepExpired(Date.now()));
  await runSweep('dumps.sweepExpired', () => sweepExpiredDumps());
};

const sweepExpiredDumps = async (): Promise<void> => {
  const store = getDumpStore();
  for (const key of await getRepo().apiKeys.list()) {
    if (key.dumpRetentionSeconds === null) continue;
    try {
      await store.purgeExpired(key.id, key.dumpRetentionSeconds);
    } catch (err) {
      console.error('[scheduled] dump sweep failed', key.id, err);
    }
  }
};
