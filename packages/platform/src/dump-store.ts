import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';

export interface DumpListOptions {
  // Exclusive cursor — return records strictly older than this id. Omit
  // for the newest page.
  before?: DumpRecordId;
  // Server-side cap (implementations enforce e.g. 200).
  limit: number;
}

// Per-key durable storage for completed request dumps. Implementations
// decide how to map a keyId to backing resources (one Durable Object per
// key on Cloudflare; one filesystem subdirectory + sqlite rows on Node).
//
// Retention is the implementation's concern, not the caller's. list/get
// lazy-filter expired rows that the sweep has not yet caught so a
// freshly-raised retention takes effect on the very next read without
// waiting for the next put or scheduled purge.
export interface DumpStore {
  put(keyId: string, record: DumpRecord): Promise<void>;
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;
  get(keyId: string, recordId: DumpRecordId): Promise<DumpRecord | null>;
  // Strict `<` against `now - retentionSeconds*1000` (ms).
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void>;
  // Removes every record for this key. Called when the key disables dump or
  // is soft-deleted.
  purgeAll(keyId: string): Promise<void>;
}
