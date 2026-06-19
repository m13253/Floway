import type {
  DumpListOptions,
  DumpStore,
  FileProvider,
  SqlDatabase,
} from '@floway-dev/platform';
import type {
  DumpMetadata,
  DumpRecord,
  DumpRecordId,
} from '@floway-dev/protocols/dump';

const MAX_LIST_LIMIT = 200;

const fileKey = (keyId: string, recordId: DumpRecordId): string =>
  `dump/${keyId}/${recordId}.json`;

const filePrefix = (keyId: string): string => `dump/${keyId}/`;

const encoder = new TextEncoder();
const decoder = new TextDecoder();

export class NodeDumpStore implements DumpStore {
  constructor(
    private readonly db: SqlDatabase,
    private readonly files: FileProvider,
    // Resolved on every read so a freshly-raised retention takes effect on
    // the very next list/get without waiting for a put or sweep to refresh
    // any cached value. Returns null when the key disabled dump capture.
    private readonly retentionResolver: (keyId: string) => Promise<number | null>,
  ) {}

  async put(keyId: string, record: DumpRecord): Promise<void> {
    await this.files.put(fileKey(keyId, record.meta.id), encoder.encode(JSON.stringify(record)));
    await this.db
      .prepare(
        'INSERT INTO dump_records (key_id, id, meta_json, created_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT (key_id, id) DO UPDATE SET '
        + 'meta_json = excluded.meta_json, created_at = excluded.created_at',
      )
      .bind(keyId, record.meta.id, JSON.stringify(record.meta), record.meta.completedAt)
      .run();
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const limit = Math.min(opts.limit, MAX_LIST_LIMIT);
    const retentionSeconds = await this.retentionResolver(keyId);
    const threshold = retentionSeconds === null ? null : Date.now() - retentionSeconds * 1000;
    // ORDER BY (created_at DESC, id DESC) lets the (key_id, created_at DESC)
    // index drive the sort. The id tie-breaker is for same-ms records — ULID
    // ids are time-ordered, so `id < before` still means "earlier in time"
    // and preserves the existing cursor contract.
    const rows = opts.before === undefined
      ? threshold === null
        ? await this.db
            .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .bind(keyId, limit)
            .all<{ meta_json: string }>()
        : await this.db
            .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .bind(keyId, threshold, limit)
            .all<{ meta_json: string }>()
      : threshold === null
        ? await this.db
            .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? AND id < ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .bind(keyId, opts.before, limit)
            .all<{ meta_json: string }>()
        : await this.db
            .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? AND id < ? AND created_at >= ? ORDER BY created_at DESC, id DESC LIMIT ?')
            .bind(keyId, opts.before, threshold, limit)
            .all<{ meta_json: string }>();
    return rows.results.map(r => JSON.parse(r.meta_json) as DumpMetadata);
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<DumpRecord | null> {
    const retentionSeconds = await this.retentionResolver(keyId);
    if (retentionSeconds !== null) {
      const threshold = Date.now() - retentionSeconds * 1000;
      const row = await this.db
        .prepare('SELECT created_at FROM dump_records WHERE key_id = ? AND id = ?')
        .bind(keyId, recordId)
        .all<{ created_at: number }>();
      const first = row.results[0];
      if (!first || first.created_at < threshold) return null;
    }
    const bytes = await this.files.get(fileKey(keyId, recordId));
    if (bytes === null) return null;
    return JSON.parse(decoder.decode(bytes)) as DumpRecord;
  }

  async purgeExpired(keyId: string, retentionSeconds: number): Promise<void> {
    const threshold = Date.now() - retentionSeconds * 1000;
    const expired = await this.db
      .prepare('SELECT id FROM dump_records WHERE key_id = ? AND created_at < ?')
      .bind(keyId, threshold)
      .all<{ id: string }>();
    for (const row of expired.results) {
      await this.files.delete(fileKey(keyId, row.id));
    }
    await this.db
      .prepare('DELETE FROM dump_records WHERE key_id = ? AND created_at < ?')
      .bind(keyId, threshold)
      .run();
  }

  async purgeAll(keyId: string): Promise<void> {
    await this.files.deletePrefix(filePrefix(keyId));
    await this.db.prepare('DELETE FROM dump_records WHERE key_id = ?').bind(keyId).run();
  }
}
