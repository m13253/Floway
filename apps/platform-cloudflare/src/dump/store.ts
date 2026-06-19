import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpStore } from '@floway-dev/platform';

// One DO per api-key. Retention is read at every put so the DO can recompute
// its alarm and cache the value for read-path lazy filtering — passing it
// through avoids a separate RPC round-trip on the hot capture path. If the
// lookup returns null at put-time (race: operator PATCHed null between
// capture start and store call), surface the inconsistency rather than
// silently dropping the record; the capture middleware already gates on
// null-retention upstream, so a null here is a real bug.
export const createCloudflareDumpStore = (
  ns: DurableObjectNamespace<KeyDumpDO>,
  retentionLookup: (keyId: string) => Promise<number | null>,
): DumpStore => {
  const stub = (keyId: string): KeyDumpDO => ns.get(ns.idFromName(keyId));
  return {
    async put(keyId, record) {
      const retention = await retentionLookup(keyId);
      if (retention === null) {
        throw new Error(`[dump] keyId=${keyId} recordId=${record.meta.id}: retentionLookup returned null at put time`);
      }
      await stub(keyId).put(keyId, retention, record);
    },
    list: (keyId, opts) => stub(keyId).list(opts),
    get: (keyId, id) => stub(keyId).getRecord(id),
    purgeExpired: (keyId, s) => stub(keyId).purgeExpired(s),
    purgeAll: keyId => stub(keyId).purgeAll(),
  };
};
