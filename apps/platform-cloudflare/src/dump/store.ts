import type { KeyDumpDO } from './key-dump-do.ts';
import type { DumpStore } from '@floway-dev/platform';

// One DO per api-key. Retention is read at every put so the DO can recompute
// its alarm; passing it through avoids a separate RPC round-trip on the hot
// capture path. A null retention from the lookup means the key disabled dump
// between the capture buffer and the store call — drop the record silently.
// Read paths forward the caller's retention so the DO applies a fresh lazy
// filter every time, rather than relying on a value cached from the last put.
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
    list: (keyId, opts, retentionSeconds) => stub(keyId).list(opts, retentionSeconds),
    get: (keyId, id, retentionSeconds) => stub(keyId).getRecord(id, retentionSeconds),
    purgeExpired: (keyId, s) => stub(keyId).purgeExpired(s),
    purgeAll: keyId => stub(keyId).purgeAll(),
  };
};
