import type { ImageCacheStore, SqlDatabase } from '@floway-dev/platform';

export class SqliteImageCache implements ImageCacheStore {
  constructor(private readonly db: SqlDatabase) {}

  async get(key: string): Promise<Uint8Array | null> {
    const row = await this.db
      .prepare('SELECT value FROM image_cache WHERE key = ? AND expires_at > ?')
      .bind(key, Date.now())
      .first<{ value: Uint8Array }>();
    return row ? new Uint8Array(row.value) : null;
  }

  async put(key: string, value: Uint8Array, ttlMs: number): Promise<void> {
    await this.db
      .prepare(
        'INSERT INTO image_cache (key, value, expires_at) VALUES (?, ?, ?) '
        + 'ON CONFLICT (key) DO UPDATE SET value = excluded.value, expires_at = excluded.expires_at',
      )
      .bind(key, value, Date.now() + ttlMs)
      .run();
  }

  async sweepExpired(now: number): Promise<void> {
    await this.db.prepare('DELETE FROM image_cache WHERE expires_at <= ?').bind(now).run();
  }
}
