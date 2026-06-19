import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpStore } from '@floway-dev/platform';

// One DO per api-key. Retention is read at every put so the DO can recompute
// its alarm and cache the value for read-path lazy filtering — passing it
// through avoids a separate RPC round-trip on the hot capture path. The
// resolver throws on unknown-key (rows are never hard-deleted under the live
// gateway), so a null return here only happens when the operator PATCHed
// retention to null between capture-start and put. The capture middleware
// already gates on null-retention upstream, so observing it here is a real
// inconsistency, not a missing-row case.
export const createCloudflareDumpStore = (
  ns: DurableObjectNamespace<KeyDumpDO>,
  retentionLookup: (keyId: string) => Promise<number | null>,
): DumpStore => {
  const stub = (keyId: string): KeyDumpDO => ns.get(ns.idFromName(keyId));
  return {
    async put(keyId, record) {
      const retention = await retentionLookup(keyId);
      if (retention === null) {
        throw new Error(`[dump] keyId=${keyId} recordId=${record.meta.id}: retention disabled by PATCH between capture-start and put`);
      }
      await stub(keyId).put(keyId, retention, record);
    },
    list: (keyId, opts) => stub(keyId).list(opts),
    get: (keyId, id) => stub(keyId).getRecord(keyId, id),
    purgeExpired: (keyId, s) => stub(keyId).purgeExpired(s),
    purgeAll: keyId => stub(keyId).purgeAll(),
  };
};
