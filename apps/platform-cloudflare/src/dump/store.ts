import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpStore } from '@floway-dev/platform';

// One DO per api-key. Retention is read at every put so the DO can recompute
// its alarm; passing it through avoids a separate RPC round-trip on the hot
// capture path. A null retention from the lookup means the key disabled dump
// between the capture buffer and the store call — drop the record silently.
export const createCloudflareDumpStore = (
  ns: DurableObjectNamespace<KeyDumpDO>,
  retentionLookup: (keyId: string) => Promise<number | null>,
): DumpStore => {
  const stub = (keyId: string): KeyDumpDO => ns.get(ns.idFromName(keyId));
  return {
    async put(keyId, record) {
      const retention = await retentionLookup(keyId);
      if (retention === null) return;
      await stub(keyId).put(keyId, retention, record);
    },
    list: (keyId, opts) => stub(keyId).list(opts),
    get: (keyId, id) => stub(keyId).getRecord(id),
    purgeExpired: (keyId, s) => stub(keyId).purgeExpired(s),
    purgeAll: keyId => stub(keyId).purgeAll(),
  };
};
