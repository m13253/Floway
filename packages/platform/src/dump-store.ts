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
// The read path takes the caller's current `retentionSeconds` so list/get
// can lazy-filter expired rows that the sweep has not yet caught — and so
// they reflect a freshly-raised retention immediately, without waiting for
// the next put or scheduled purge to refresh any cached value. `null`
// disables the filter (no positive retention is in effect for this key).
export interface DumpStore {
  put(keyId: string, record: DumpRecord): Promise<void>;
  list(keyId: string, opts: DumpListOptions, retentionSeconds: number | null): Promise<DumpMetadata[]>;
  get(keyId: string, recordId: DumpRecordId, retentionSeconds: number | null): Promise<DumpRecord | null>;
  // Removes records whose created_at is older than now - retentionSeconds*1000.
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void>;
  // Removes every record for this key. Called when the key disables dump or
  // is soft-deleted.
  purgeAll(keyId: string): Promise<void>;
}
