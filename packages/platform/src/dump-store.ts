import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';

// Per-API-key request dump storage contract. Implementations live in the
// platform-target apps (`apps/platform-*`), backed by D1 + FileProvider on
// Cloudflare and by node:sqlite + filesystem on Node. The gateway core only
// holds the abstract interface and binds to the concrete impl through
// `initDumpStore` / `getDumpStore`.
//
// Body storage is split: D1 carries metadata + headers + per-side
// descriptors; the FileProvider carries the gzipped body bytes themselves
// at hour-bucketed paths `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}.{req|resp}.gz`.
// The hour bucket exists so the cron sweep can `deletePrefix` whole
// expired hours without per-record file enumeration.

export interface DumpListOptions {
  before?: DumpRecordId;
  limit: number;
}

export interface DumpStore {
  // Persist a freshly-captured record. Implementations must write the body
  // files BEFORE inserting the D1 row, so a partial failure leaves orphan
  // files (which the sweep will catch) rather than orphan rows (which
  // would surface as broken records in list/get).
  put(keyId: string, record: DumpRecord): Promise<void>;

  // Newest-first metadata-only list, paginated by ULID cursor. Implementations
  // return every stored record matching the cursor/limit; physical retention
  // enforcement is the cron sweep's responsibility, not list's. Between sweeps
  // the dashboard may briefly show records that have aged past retention; the
  // next sweep window will drop them.
  list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]>;

  // Full record fetch: rehydrates body files from the FileProvider, ungzips,
  // and assembles the wire-shape `DumpRecord` (wraps each body in a `DumpBody`
  // discriminated union — utf8 for text, base64 otherwise; the captured
  // content-type header is preserved verbatim). Returns null when the record
  // does not exist (deleted, expired, or never existed).
  get(keyId: string, recordId: DumpRecordId): Promise<DumpRecord | null>;

  // Drop every record (rows + files) for this key. Used by api-key delete,
  // user delete cascade, and PATCH retention=null. Idempotent.
  purgeAll(keyId: string): Promise<void>;

  // Drop records older than `now - retentionSeconds*1000` for this key. Used
  // by the cron sweep and by PATCH retention-shrink. Idempotent.
  purgeExpired(keyId: string, retentionSeconds: number): Promise<void>;
}
