import { expect, test, vi } from 'vitest';

import { purgeDumpsForAllKeys } from './purge.ts';
import type { DumpListOptions, DumpStore } from '@floway-dev/platform';
import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';
import { assertEquals } from '@floway-dev/test-utils';

class RecordingDumpStore implements DumpStore {
  readonly purgedExpired: Array<{ keyId: string; retentionSeconds: number }> = [];
  private readonly throwFor: Set<string>;

  constructor(throwFor: Iterable<string> = []) {
    this.throwFor = new Set(throwFor);
  }

  put(_keyId: string, _record: DumpRecord): Promise<void> { return Promise.resolve(); }
  list(_keyId: string, _opts: DumpListOptions): Promise<DumpMetadata[]> { return Promise.resolve([]); }
  get(_keyId: string, _id: DumpRecordId): Promise<DumpRecord | null> { return Promise.resolve(null); }
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void> {
    if (this.throwFor.has(keyId)) return Promise.reject(new Error(`boom for ${keyId}`));
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

test('a single failing key does not skip later keys; the failure is logged with the keyId', async () => {
  const store = new RecordingDumpStore(['key-a']);
  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
  try {
    await purgeDumpsForAllKeys(store, [
      { id: 'key-a', dumpRetentionSeconds: 3600 },
      { id: 'key-b', dumpRetentionSeconds: 60 },
      { id: 'key-c', dumpRetentionSeconds: 120 },
    ]);
    assertEquals(store.purgedExpired, [
      { keyId: 'key-b', retentionSeconds: 60 },
      { keyId: 'key-c', retentionSeconds: 120 },
    ]);
    assertEquals(errorSpy.mock.calls.length, 1);
    assertEquals(errorSpy.mock.calls[0]![0], '[dump-purge]');
    assertEquals(errorSpy.mock.calls[0]![1], 'key-a');
    expect(errorSpy.mock.calls[0]![2]).toBeInstanceOf(Error);
    expect((errorSpy.mock.calls[0]![2] as Error).message).toMatch(/boom for key-a/);
  } finally {
    errorSpy.mockRestore();
  }
});
