import { test } from 'vitest';

import { purgeDumpsForAllKeys } from './purge.ts';
import type { DumpListOptions, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

class RecordingDumpStore implements DumpStore {
  readonly purgedExpired: Array<{ keyId: string; retentionSeconds: number }> = [];

  put(_keyId: string, _record: DumpRecord): Promise<void> { return Promise.resolve(); }
  list(_keyId: string, _opts: DumpListOptions): Promise<DumpMetadata[]> { return Promise.resolve([]); }
  get(_keyId: string, _id: DumpRecordId): Promise<DumpRecord | null> { return Promise.resolve(null); }
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void> {
    this.purgedExpired.push({ keyId, retentionSeconds });
    return Promise.resolve();
  }
  purgeAll(_keyId: string): Promise<void> { return Promise.resolve(); }
}

test('skips keys whose dumpRetentionSeconds is null, purges the rest', async () => {
  const store = new RecordingDumpStore();
  await purgeDumpsForAllKeys(store, [
    { id: 'key-a', dumpRetentionSeconds: 3600 },
    { id: 'key-b', dumpRetentionSeconds: null },
    { id: 'key-c', dumpRetentionSeconds: 60 },
  ]);
  assertEquals(store.purgedExpired, [
    { keyId: 'key-a', retentionSeconds: 3600 },
    { keyId: 'key-c', retentionSeconds: 60 },
  ]);
});

test('no-op when every key has retention disabled', async () => {
  const store = new RecordingDumpStore();
  await purgeDumpsForAllKeys(store, [
    { id: 'key-a', dumpRetentionSeconds: null },
    { id: 'key-b', dumpRetentionSeconds: null },
  ]);
  assertEquals(store.purgedExpired, []);
});
