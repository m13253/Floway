import { test, vi } from 'vitest';

import type { R2BucketLike } from '../r2-file-provider.ts';
import { assert } from '@floway-dev/test-utils';

// The DO base class lives behind a runtime module that vitest cannot resolve;
// stub it with a permissive class so the file can be imported in a plain Node
// test environment.
vi.mock('cloudflare:workers', () => ({
  DurableObject: class <Env = unknown> {
    protected ctx: unknown;
    protected env: Env;
    constructor(ctx: unknown, env: Env) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

// Import after the mock declaration so the import chain picks up the stub.
const { KeyDumpDO } = await import('./key-dump-do.ts');

// Minimal SQL backing for the DO — a tiny per-shape switch over the statements
// the DO actually issues during purgeExpired on an empty store is enough, and
// avoids pulling node:sqlite (or a real sqlite engine) into the cloudflare
// platform's test deps. Anything unstubbed throws so missing coverage is loud.
interface Row { id?: string; created_at?: number; v?: string }

const makeSql = () => {
  const records: Array<{ id: string; meta_json: string; created_at: number }> = [];
  const state = new Map<string, string>();
  return {
    exec<T = Row>(query: string, ...bindings: unknown[]): { toArray: () => T[]; one: () => T | undefined } {
      const q = query.replace(/\s+/g, ' ').trim();
      if (q.startsWith('CREATE TABLE') || q.startsWith('CREATE INDEX')) {
        return { toArray: () => [], one: () => undefined };
      }
      if (q.startsWith('SELECT v FROM state WHERE k = ?')) {
        const v = state.get(bindings[0] as string);
        const row = v === undefined ? undefined : ({ v } as unknown as T);
        return { toArray: () => row === undefined ? [] : [row], one: () => row };
      }
      if (q.startsWith('INSERT OR REPLACE INTO state')) {
        state.set(bindings[0] as string, bindings[1] as string);
        return { toArray: () => [], one: () => undefined };
      }
      if (q.startsWith('SELECT id FROM records WHERE created_at < ?')) {
        const cutoff = bindings[0] as number;
        const rows = records.filter(r => r.created_at < cutoff).map(r => ({ id: r.id } as unknown as T));
        return { toArray: () => rows, one: () => rows[0] };
      }
      if (q.startsWith('DELETE FROM records WHERE created_at < ?')) {
        const cutoff = bindings[0] as number;
        for (let i = records.length - 1; i >= 0; i--) {
          if (records[i]!.created_at < cutoff) records.splice(i, 1);
        }
        return { toArray: () => [], one: () => undefined };
      }
      if (q.startsWith('SELECT created_at FROM records ORDER BY created_at ASC LIMIT 1')) {
        const sorted = records.toSorted((a, b) => a.created_at - b.created_at);
        const row = sorted[0] === undefined ? undefined : ({ created_at: sorted[0].created_at } as unknown as T);
        return { toArray: () => row === undefined ? [] : [row], one: () => row };
      }
      throw new Error(`unstubbed SQL: ${q}`);
    },
  };
};

const makeCtx = () => {
  const sql = makeSql();
  let alarm: number | null = null;
  return {
    sql,
    storage: {
      sql,
      setAlarm: async (ts: number | Date) => { alarm = typeof ts === 'number' ? ts : ts.getTime(); },
      getAlarm: async () => alarm,
      deleteAlarm: async () => { alarm = null; },
      deleteAll: async () => {},
    },
    acceptWebSocket: () => {},
    getWebSockets: () => [],
  };
};

const fakeR2: R2BucketLike = {
  put: async () => ({}),
  get: async () => null,
  delete: async () => {},
  list: async () => ({ objects: [], truncated: false }),
};

interface KeyDumpDOLike {
  purgeExpired: (keyId: string, retentionSeconds: number) => Promise<void>;
}

test('purgeExpired succeeds on a fresh DO with no prior put (no cached keyId in state)', async () => {
  const ctx = makeCtx();
  // The DO constructor runs SCHEMA statements; our SQL stub no-ops CREATE TABLE
  // so the storage starts empty, mirroring a brand-new per-key DO that the
  // control plane PATCH-enables retention against before any capture lands.
  const env = { DUMP_BLOBS: fakeR2 };
  const Ctor = KeyDumpDO as unknown as new (ctx: unknown, env: unknown) => KeyDumpDOLike;
  const subject = new Ctor(ctx, env);

  // Must not throw — purgeOlderThan's "state was wiped" tripwire is only
  // meant to catch a corrupted DO, not the legitimate first-PATCH-on-empty-DO
  // path.
  let threw: unknown = null;
  try {
    await subject.purgeExpired('key-fresh', 3600);
  } catch (err) {
    threw = err;
  }
  assert(threw === null, `purgeExpired should not throw on fresh DO, got: ${String(threw)}`);
});
