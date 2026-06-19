import { DurableObject } from 'cloudflare:workers';

import type { R2BucketLike } from '../r2-file-provider.ts';
import type { DumpMetadata, DumpRecord, DumpRecordId } from '@floway-dev/protocols/dump';

export interface KeyDumpDOEnv {
  DUMP_BLOBS: R2BucketLike;
}

const SCHEMA = [
  'CREATE TABLE IF NOT EXISTS records ('
  + ' id TEXT PRIMARY KEY,'
  + ' meta_json TEXT NOT NULL,'
  + ' created_at INTEGER NOT NULL'
  + ')',
  'CREATE INDEX IF NOT EXISTS idx_records_created ON records(created_at DESC)',
  'CREATE TABLE IF NOT EXISTS state ('
  + ' k TEXT PRIMARY KEY,'
  + ' v TEXT NOT NULL'
  + ')',
];

// R2 bulk delete is capped at 1000 keys per call, so chunk every batch.
// https://developers.cloudflare.com/r2/api/workers/workers-api-reference/#bucket-method-definitions
const R2_DELETE_BATCH = 1000;

const blobKey = (keyId: string, recordId: string): string => `dump/${keyId}/${recordId}.json`;

export class KeyDumpDO extends DurableObject<KeyDumpDOEnv> {
  private readonly sql = this.ctx.storage.sql;
  private readonly sockets = new Set<WebSocket>();

  constructor(ctx: DurableObjectState, env: KeyDumpDOEnv) {
    super(ctx, env);
    for (const stmt of SCHEMA) this.sql.exec(stmt);
    // After hibernation, re-attach to the sockets the runtime kept alive.
    for (const ws of this.ctx.getWebSockets()) this.sockets.add(ws);
  }

  async put(keyId: string, retentionSeconds: number, record: DumpRecord): Promise<void> {
    this.writeState('keyId', keyId);
    this.writeState('retentionSeconds', String(retentionSeconds));

    await this.env.DUMP_BLOBS.put(blobKey(keyId, record.meta.id), JSON.stringify(record));
    // created_at uses completedAt so retention measures the lifetime of the
    // stored record, not the wall-clock duration of the request that produced
    // it. A long-running request would otherwise be born already partly aged.
    this.sql.exec(
      'INSERT OR REPLACE INTO records(id, meta_json, created_at) VALUES(?, ?, ?)',
      record.meta.id,
      JSON.stringify(record.meta),
      record.meta.completedAt,
    );

    this.fanout(record.meta);
    await this.scheduleNextAlarm(retentionSeconds);
  }

  async list(opts: { before?: DumpRecordId; limit: number }): Promise<DumpMetadata[]> {
    const limit = Math.min(Math.max(opts.limit, 1), 200);
    const cutoff = this.expiryCutoff();
    const rows = opts.before !== undefined
      ? this.sql.exec<{ meta_json: string }>(
          'SELECT meta_json FROM records WHERE id < ? AND created_at >= ? ORDER BY id DESC LIMIT ?',
          opts.before,
          cutoff,
          limit,
        ).toArray()
      : this.sql.exec<{ meta_json: string }>(
          'SELECT meta_json FROM records WHERE created_at >= ? ORDER BY id DESC LIMIT ?',
          cutoff,
          limit,
        ).toArray();
    return rows.map(r => JSON.parse(r.meta_json) as DumpMetadata);
  }

  async getRecord(keyId: string, id: DumpRecordId): Promise<DumpRecord | null> {
    const cutoff = this.expiryCutoff();
    const [row] = this.sql
      .exec<{ created_at: number }>('SELECT created_at FROM records WHERE id = ?', id)
      .toArray();
    if (!row || row.created_at < cutoff) return null;
    const object = await this.env.DUMP_BLOBS.get(blobKey(keyId, id));
    if (!object) return null;
    return JSON.parse(new TextDecoder().decode(await object.arrayBuffer())) as DumpRecord;
  }

  async purgeExpired(retentionSeconds: number): Promise<void> {
    this.writeState('retentionSeconds', String(retentionSeconds));
    await this.purgeOlderThan(Date.now() - retentionSeconds * 1000);
    await this.scheduleNextAlarm(retentionSeconds);
  }

  async purgeAll(): Promise<void> {
    const keyId = this.readState('keyId');
    if (keyId !== undefined) await this.deleteR2Prefix(`dump/${keyId}/`);
    await this.ctx.storage.deleteAll();
    // deleteAll drops every SQLite table, including `records` and `state`,
    // but the runtime keeps the DO instance alive so the constructor (which
    // creates the schema) does not run again until eviction. Re-create the
    // schema here so the next put / purgeExpired hits live tables instead
    // of `no such table: state`.
    for (const stmt of SCHEMA) this.sql.exec(stmt);
  }

  async alarm(): Promise<void> {
    const raw = this.readState('retentionSeconds');
    // deleteAll-then-new-put race: purgeAll dropped the state row but the
    // alarm fires before the next put rewrites it. No retention to enforce
    // yet — bail and let the next put re-schedule.
    if (raw === undefined) return;
    const retention = Number(raw);
    if (retention <= 0) return;
    await this.purgeOlderThan(Date.now() - retention * 1000);
    await this.scheduleNextAlarm(retention);
  }

  async fetch(req: Request): Promise<Response> {
    if (req.headers.get('upgrade') !== 'websocket') {
      return new Response('expected websocket upgrade', { status: 426 });
    }
    const pair = new WebSocketPair();
    this.ctx.acceptWebSocket(pair[1]);
    this.sockets.add(pair[1]);
    return new Response(null, { status: 101, webSocket: pair[0] });
  }

  async webSocketMessage(_ws: WebSocket, _message: string | ArrayBuffer): Promise<void> {
    // Dashboards never send to us; ping/pong is handled by the runtime.
  }

  async webSocketClose(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  async webSocketError(ws: WebSocket): Promise<void> {
    this.sockets.delete(ws);
  }

  private fanout(meta: DumpMetadata): void {
    const payload = JSON.stringify(meta);
    for (const ws of this.sockets) {
      try {
        ws.send(payload);
      } catch {
        try { ws.close(1011, 'send-failed'); } catch {}
        this.sockets.delete(ws);
      }
    }
  }

  private async purgeOlderThan(cutoffMs: number): Promise<void> {
    const keyId = this.readState('keyId');
    const expiring = this.sql
      .exec<{ id: string }>('SELECT id FROM records WHERE created_at < ?', cutoffMs)
      .toArray();
    if (keyId !== undefined && expiring.length > 0) {
      const keys = expiring.map(r => blobKey(keyId, r.id));
      for (let i = 0; i < keys.length; i += R2_DELETE_BATCH) {
        await this.env.DUMP_BLOBS.delete(keys.slice(i, i + R2_DELETE_BATCH));
      }
    }
    this.sql.exec('DELETE FROM records WHERE created_at < ?', cutoffMs);
  }

  // List + delete pagination for purgeAll, so we sweep any orphans an
  // interrupted put may have left behind in addition to the indexed records.
  private async deleteR2Prefix(prefix: string): Promise<void> {
    let cursor: string | undefined;
    do {
      const page = await this.env.DUMP_BLOBS.list({ prefix, cursor, limit: R2_DELETE_BATCH });
      if (page.objects.length > 0) {
        await this.env.DUMP_BLOBS.delete(page.objects.map(o => o.key));
      }
      cursor = page.truncated ? page.cursor : undefined;
    } while (cursor !== undefined);
  }

  // The alarm only ever fires for the next record about to expire. Re-running
  // it after every put keeps the schedule tight without overwriting an earlier
  // pending alarm; an empty table clears the alarm entirely.
  private async scheduleNextAlarm(retentionSeconds: number): Promise<void> {
    // .toArray()[0] returns undefined on an empty result set; .one() would
    // throw "Expected exactly one result" and we want the empty-records
    // case to gracefully clear the alarm.
    const [oldest] = this.sql
      .exec<{ created_at: number }>('SELECT created_at FROM records ORDER BY created_at ASC LIMIT 1')
      .toArray();
    if (!oldest) {
      await this.ctx.storage.deleteAlarm();
      return;
    }
    const expiresAt = oldest.created_at + retentionSeconds * 1000;
    const current = await this.ctx.storage.getAlarm();
    if (current === null || current > expiresAt) await this.ctx.storage.setAlarm(expiresAt);
  }

  private expiryCutoff(): number {
    const raw = this.readState('retentionSeconds');
    // No state row (DO just initialized, or purgeAll dropped it) means we
    // have no retention to enforce yet — return -Infinity so list/get
    // include every row.
    if (raw === undefined) return -Infinity;
    const retention = Number(raw);
    if (!Number.isFinite(retention) || retention <= 0) return -Infinity;
    return Date.now() - retention * 1000;
  }

  private readState(k: string): string | undefined {
    // .toArray()[0] returns undefined on missing row; .one() throws which
    // would break the "no state yet" branches in expiryCutoff / alarm.
    const [row] = this.sql.exec<{ v: string }>('SELECT v FROM state WHERE k = ?', k).toArray();
    return row?.v;
  }

  private writeState(k: string, v: string): void {
    this.sql.exec('INSERT OR REPLACE INTO state(k, v) VALUES(?, ?)', k, v);
  }
}
