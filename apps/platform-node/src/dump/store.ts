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

// Page size cap — list() will never return more rows than this, regardless of
// what the caller asks for.
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
  ) {}

  async put(keyId: string, record: DumpRecord): Promise<void> {
    await this.files.put(fileKey(keyId, record.meta.id), encoder.encode(JSON.stringify(record)));
    await this.db
      .prepare(
        'INSERT INTO dump_records (key_id, id, meta_json, created_at) VALUES (?, ?, ?, ?) '
        + 'ON CONFLICT (key_id, id) DO UPDATE SET '
        + 'meta_json = excluded.meta_json, created_at = excluded.created_at',
      )
      .bind(keyId, record.meta.id, JSON.stringify(record.meta), record.meta.startedAt)
      .run();
  }

  async list(keyId: string, opts: DumpListOptions): Promise<DumpMetadata[]> {
    const limit = Math.min(opts.limit, MAX_LIST_LIMIT);
    const rows = opts.before === undefined
      ? await this.db
          .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? ORDER BY id DESC LIMIT ?')
          .bind(keyId, limit)
          .all<{ meta_json: string }>()
      : await this.db
          .prepare('SELECT meta_json FROM dump_records WHERE key_id = ? AND id < ? ORDER BY id DESC LIMIT ?')
          .bind(keyId, opts.before, limit)
          .all<{ meta_json: string }>();
    return rows.results.map(r => JSON.parse(r.meta_json) as DumpMetadata);
  }

  async get(keyId: string, recordId: DumpRecordId): Promise<DumpRecord | null> {
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
      await this.files.deletePrefix(fileKey(keyId, row.id));
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
