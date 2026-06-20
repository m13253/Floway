import { decodeBodyFromWire, encodeBodyForWire } from '../shared/dump-wire.ts';
import type {
  DumpListOptions,
  DumpStore,
  FileProvider, SqlDatabase,
} from '@floway-dev/platform';
import type {
  DumpMetadata,
  DumpRecord,
  DumpRecordId,
  DumpRequest,
  DumpResponse,
  DumpResponseBody,
  DumpStreamEvent,
} from '@floway-dev/protocols/dump';

// File-backed `DumpStore` impl shared between deployment targets. See the
// interface contract in `packages/platform/src/dump-store.ts` for the
// metadata-in-SQL / bytes-in-FileProvider split.
//
// Concrete layout: bodies live under hour-bucketed FileProvider keys
// `dumps/v1/{keyId}/{YYYYMMDDHH}/{recordId}.{req|resp}.gz`. The hour bucket
// exists so the cron sweep can `deletePrefix` whole expired hours without
// per-record file enumeration.

const ROOT = 'dumps/v1';
const HOUR_MS = 60 * 60 * 1000;

interface BodyDescriptor {
  key: string;
  contentType: string;
  // 'bytes' for non-SSE responses, 'events' for SSE-parsed responses (the
  // body file holds the JSON array of DumpStreamEvent). Absent on request-
  // side descriptors — request bodies are always 'bytes' there.
  type?: 'bytes' | 'events';
}

interface DumpRow {
  id: string;
  created_at: number;
  meta_json: string;
  request_headers_json: string;
  response_headers_json: string | null;
  request_body_descriptor: string | null;
  response_body_descriptor: string | null;
}

const hourBucket = (ms: number): string => {
  const date = new Date(Math.floor(ms / HOUR_MS) * HOUR_MS);
  const y = date.getUTCFullYear().toString().padStart(4, '0');
  const m = (date.getUTCMonth() + 1).toString().padStart(2, '0');
  const d = date.getUTCDate().toString().padStart(2, '0');
  const h = date.getUTCHours().toString().padStart(2, '0');
  return `${y}${m}${d}${h}`;
};

const hourBucketToMs = (bucket: string): number | null => {
  if (!/^\d{10}$/.test(bucket)) return null;
  const y = Number(bucket.slice(0, 4));
  const m = Number(bucket.slice(4, 6));
  const d = Number(bucket.slice(6, 8));
  const h = Number(bucket.slice(8, 10));
  return Date.UTC(y, m - 1, d, h, 0, 0, 0);
};

const keyPrefix = (keyId: string): string => `${ROOT}/${keyId}/`;
const bucketPrefix = (keyId: string, bucket: string): string => `${ROOT}/${keyId}/${bucket}/`;
const bodyPath = (keyId: string, bucket: string, recordId: string, side: 'req' | 'resp'): string =>
  `${bucketPrefix(keyId, bucket)}${recordId}.${side}.gz`;

const gzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new CompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const gunzip = async (bytes: Uint8Array): Promise<Uint8Array> => {
  const stream = new Response(new Blob([bytes as BlobPart]).stream().pipeThrough(new DecompressionStream('gzip')));
  return new Uint8Array(await stream.arrayBuffer());
};

const requestContentType = (request: DumpRequest): string => {
  for (const [name, value] of request.headers) {
    if (name.toLowerCase() === 'content-type') return value;
  }
  return '';
};

const responseContentType = (response: DumpResponse): string => {
  for (const [name, value] of response.headers) {
    if (name.toLowerCase() === 'content-type') return value;
  }
  return '';
};

const putBody = async (
  files: FileProvider,
  key: string,
  rawBytes: Uint8Array,
  contentType: string,
  type: 'bytes' | 'events' | undefined,
): Promise<BodyDescriptor> => {
  const gz = await gzip(rawBytes);
  await files.put(key, gz);
  const descriptor: BodyDescriptor = {
    key,
    contentType,
  };
  if (type !== undefined) descriptor.type = type;
  return descriptor;
};

const fetchBody = async (files: FileProvider, descriptor: BodyDescriptor): Promise<Uint8Array> => {
  const gz = await files.get(descriptor.key);
  if (!gz) throw new Error(`dump body missing for key=${descriptor.key}`);
  return await gunzip(gz);
};

const fetchEventsBody = async (files: FileProvider, descriptor: BodyDescriptor): Promise<DumpStreamEvent[]> => {
  const raw = await fetchBody(files, descriptor);
  const parsed = JSON.parse(new TextDecoder().decode(raw));
  if (!Array.isArray(parsed)) throw new Error(`dump events payload not an array at key=${descriptor.key}`);
  return parsed as DumpStreamEvent[];
};

export class FileDumpStore implements DumpStore {
  constructor(private readonly db: SqlDatabase, private readonly files: FileProvider) {}

  async put(keyId: string, record: DumpRecord): Promise<void> {
    const bucket = hourBucket(record.meta.completedAt);
    const requestRaw = decodeBodyFromWire(record.request.body);
    const requestDescriptor = requestRaw.byteLength === 0
      ? null
      : await putBody(this.files, bodyPath(keyId, bucket, record.meta.id, 'req'), requestRaw, requestContentType(record.request), undefined);

    let responseDescriptor: BodyDescriptor | null = null;
    if (record.response.type === 'bytes') {
      const responseRaw = decodeBodyFromWire(record.response.body);
      if (responseRaw.byteLength > 0) {
        responseDescriptor = await putBody(this.files, bodyPath(keyId, bucket, record.meta.id, 'resp'), responseRaw, responseContentType(record.response), 'bytes');
      }
    } else if (record.response.type === 'stream') {
      const eventsJson = new TextEncoder().encode(JSON.stringify(record.response.events));
      responseDescriptor = await putBody(this.files, bodyPath(keyId, bucket, record.meta.id, 'resp'), eventsJson, responseContentType(record.response), 'events');
    }

    // Files first, then the row — a partial failure leaves orphan files the
    // hour-bucket sweep collects, never an orphan row whose detail fetch
    // would 404 after a successful list.
    await this.db.prepare(
      `INSERT INTO dump_records
       (key_id, id, created_at, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    ).bind(
      keyId,
      record.meta.id,
      record.meta.completedAt,
      JSON.stringify(record.meta),
      JSON.stringify(record.request.headers),
      record.response.type === 'none' ? null : JSON.stringify(record.response.headers),
      requestDescriptor === null ? null : JSON.stringify(requestDescriptor),
      responseDescriptor === null ? null : JSON.stringify(responseDescriptor),
    ).run();
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const before = opts.before
      ? await this.db.prepare(
          'SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?',
        ).bind(keyId, opts.before).first<{ created_at: number }>()
      : null;
    const beforeTs = before?.created_at ?? null;

    // Newest-first with a compound (created_at, id) cursor so two rows that
    // share a millisecond still page deterministically. ULID lex order
    // matches creation order within the millisecond.
    const sql = beforeTs === null
      ? 'SELECT meta_json FROM dump_records WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?'
      : 'SELECT meta_json FROM dump_records WHERE key_id = ? AND (created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT ?';
    const stmt = beforeTs === null
      ? this.db.prepare(sql).bind(keyId, opts.limit)
      : this.db.prepare(sql).bind(keyId, beforeTs, beforeTs, opts.before!, opts.limit);
    const { results } = await stmt.all<{ meta_json: string }>();
    return results.map(row => JSON.parse(row.meta_json) as DumpMetadata);
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<DumpRecord | null> {
    const row = await this.db.prepare(
      'SELECT id, created_at, meta_json, request_headers_json, response_headers_json, request_body_descriptor, response_body_descriptor FROM dump_records WHERE key_id = ? AND id = ?',
    ).bind(keyId, recordId).first<DumpRow>();
    if (!row) return null;

    const meta = JSON.parse(row.meta_json) as DumpMetadata;
    const requestHeaders = JSON.parse(row.request_headers_json) as Array<[string, string]>;
    const requestDescriptor = row.request_body_descriptor ? JSON.parse(row.request_body_descriptor) as BodyDescriptor : null;
    const responseHeaders = row.response_headers_json ? JSON.parse(row.response_headers_json) as Array<[string, string]> : null;
    const responseDescriptor = row.response_body_descriptor ? JSON.parse(row.response_body_descriptor) as BodyDescriptor : null;

    const request: DumpRequest = {
      method: meta.method,
      path: meta.path,
      headers: requestHeaders,
      body: requestDescriptor
        ? encodeBodyForWire(await fetchBody(this.files, requestDescriptor), requestDescriptor.contentType)
        : { encoding: 'utf8', data: '' },
    };

    let responseBody: DumpResponseBody;
    if (responseDescriptor === null || responseHeaders === null) {
      responseBody = { type: 'none' };
    } else if (responseDescriptor.type === 'events') {
      responseBody = { type: 'stream', events: await fetchEventsBody(this.files, responseDescriptor) };
    } else {
      responseBody = {
        type: 'bytes',
        body: encodeBodyForWire(await fetchBody(this.files, responseDescriptor), responseDescriptor.contentType),
      };
    }

    // No response headers row means the request never produced an upstream
    // response (capture middleware writes the row even on synthesized 500s,
    // where status comes from accounting but no real headers exist). Surface
    // that as an empty header list — the wire shape requires the array.
    const response: DumpResponse & DumpResponseBody = {
      status: meta.status,
      headers: responseHeaders ?? [],
      ...responseBody,
    };
    return { meta, request, response };
  }

  async purgeAll(keyId: string): Promise<void> {
    // Files first, then the rows — matches `put`'s ordering invariant. A
    // partial failure leaves rows pointing at gone files (detail-fetch then
    // throws `dump body missing`, the documented loud-failure path) and the
    // next sweep retries cleanly. The reverse order would orphan files no
    // row references, which the cron sweep (D1-driven) could never reach.
    await this.files.deletePrefix(keyPrefix(keyId));
    await this.db.prepare('DELETE FROM dump_records WHERE key_id = ?').bind(keyId).run();
  }

  async purgeExpired(keyId: string, retentionSeconds: number): Promise<void> {
    const cutoff = Date.now() - retentionSeconds * 1000;

    // Enumerate the immediate hour-bucket subprefixes by listing every file
    // under the key root and grouping by the bucket segment. R2 doesn't ship a
    // generic FileProvider `list(delimiter)` so we derive buckets from keys
    // directly — overkill for hot keys but bounded by the FileProvider's own
    // listKeys pagination.
    const prefix = keyPrefix(keyId);
    const buckets = new Set<string>();
    for (const file of await this.files.listKeys(prefix)) {
      const tail = file.slice(prefix.length);
      const slash = tail.indexOf('/');
      if (slash > 0) buckets.add(tail.slice(0, slash));
    }
    for (const bucket of buckets) {
      const bucketStart = hourBucketToMs(bucket);
      if (bucketStart === null) continue;
      // A bucket whose newest possible record is still within the window must
      // stay: bucketEnd is the first millisecond of the next hour.
      const bucketEnd = bucketStart + HOUR_MS;
      if (bucketEnd <= cutoff) await this.files.deletePrefix(bucketPrefix(keyId, bucket));
    }

    await this.db.prepare('DELETE FROM dump_records WHERE key_id = ? AND created_at < ?').bind(keyId, cutoff).run();
  }
}
