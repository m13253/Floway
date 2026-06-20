import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';

import { test } from 'vitest';

import { FileDumpStore } from './dump-store.ts';
import { MemoryFileProvider } from '@floway-dev/platform';
import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';
import type { DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// Thin SqlDatabase adapter over node:sqlite's DatabaseSync, kept inside the
// test file because the production gateway core never needs it — node-only
// production code lives in apps/platform-node. Mirrors the shape of the
// Node app's wrapper just enough to back the dump-store schema.
const MIGRATION_PATH = resolve(fileURLToPath(import.meta.url), '..', '..', '..', 'migrations', '0037_dump_records.sql');

const openDb = async (): Promise<SqlDatabase> => {
  const sqlite = new DatabaseSync(':memory:');
  sqlite.exec(await readFile(MIGRATION_PATH, 'utf8'));
  return {
    prepare(query): SqlPreparedStatement {
      const stmt = sqlite.prepare(query);
      const make = (bound: unknown[]): SqlPreparedStatement => ({
        bind(...values) { return make(values); },
        first: async <T = Record<string, unknown>>() =>
          (stmt.get(...bound as never[]) as T | undefined) ?? null,
        all: async <T = Record<string, unknown>>() => ({
          results: stmt.all(...bound as never[]) as T[],
          success: true,
          meta: {},
        } satisfies SqlResult<T>),
        run: async () => {
          const r = stmt.run(...bound as never[]);
          return { results: [], success: true, meta: { changes: Number(r.changes) } } satisfies SqlResult;
        },
      });
      return make([]);
    },
    exec: async sql => { sqlite.exec(sql); },
  };
};

const baseRecord = (id: string, completedAt: number): DumpRecord => ({
  meta: {
    id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
    upstream: null, model: 'm', inputTokens: 1, outputTokens: 2,
    requestBytes: 3, responseBytes: 4, durationMs: 1, error: null,
  },
  request: {
    method: 'POST', path: '/v1/x',
    headers: [['content-type', 'application/json']],
    body: { encoding: 'utf8', data: '{"hello":"world"}' },
  },
  response: {
    status: 200,
    headers: [['content-type', 'application/json']],
    type: 'bytes',
    body: { encoding: 'utf8', data: '{"id":"abc"}' },
  },
});

test('FileDumpStore round-trips a JSON record through gzip', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const record = baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0));

  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
  assertExists(fetched);
  assertEquals(fetched.meta.id, record.meta.id);
  assertEquals(fetched.request.body.encoding, 'utf8');
  assertEquals(fetched.request.body.data, '{"hello":"world"}');
  if (fetched.response.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(fetched.response.body.encoding, 'utf8');
  assertEquals(fetched.response.body.data, '{"id":"abc"}');
});

test('FileDumpStore preserves the original content-type header on binary bodies', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const pngMagic = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A]).toString('base64');
  const record: DumpRecord = {
    ...baseRecord('01HZZ0000000000000000000PNG', Date.UTC(2026, 5, 1, 12, 0, 0)),
    response: {
      status: 200,
      headers: [['content-type', 'image/png']],
      type: 'bytes',
      body: { encoding: 'base64', data: pngMagic },
    },
  };

  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000PNG');
  assertExists(fetched);
  // The header pair must survive verbatim — no `;base64` suffix tacked on.
  assertEquals(fetched.response.headers.find(([k]) => k === 'content-type')?.[1], 'image/png');
  if (fetched.response.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(fetched.response.body.encoding, 'base64');
  assertEquals(fetched.response.body.data, pngMagic);
});

test('FileDumpStore round-trips an SSE record as a stream events array', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const record: DumpRecord = {
    ...baseRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)),
    response: {
      status: 200,
      headers: [['content-type', 'text/event-stream']],
      type: 'stream',
      events: [
        { event: 'ping', data: 'hi', ts: 10 },
        { event: null, data: 'done', ts: 20 },
      ],
    },
  };
  await store.put('key_x', record);
  const fetched = await store.get('key_x', '01HZZ0000000000000000000A2');
  assertExists(fetched);
  if (fetched.response.type !== 'stream') throw new Error('expected stream');
  assertEquals(fetched.response.events.length, 2);
  assertEquals(fetched.response.events[0]!.data, 'hi');
});

test('FileDumpStore.list paginates newest-first with the (createdAt, id) cursor', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const base = Date.UTC(2026, 5, 1, 12, 0, 0);
  for (let i = 0; i < 5; i++) {
    await store.put('key_x', baseRecord(`01HZZ000000000000000000A0${i}`, base + i));
  }
  const first = await store.list('key_x', { limit: 2 });
  assertEquals(first.map(m => m.id), ['01HZZ000000000000000000A04', '01HZZ000000000000000000A03']);
  const next = await store.list('key_x', { limit: 2, before: '01HZZ000000000000000000A03' });
  assertEquals(next.map(m => m.id), ['01HZZ000000000000000000A02', '01HZZ000000000000000000A01']);
});

test('FileDumpStore.purgeExpired drops rows past the cutoff and sweeps whole hour buckets', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  const now = Date.UTC(2026, 5, 1, 12, 0, 0);
  // Old bucket 9:xx, current bucket 12:xx.
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', now));
  // 2 hours retention; the old bucket is past the cutoff and should disappear,
  // but the now bucket must stay because its end is still within the window.
  const originalNow = Date.now;
  Date.now = () => now + 1;
  try {
    await store.purgeExpired('key_x', 2 * 3600);
  } finally {
    Date.now = originalNow;
  }
  const left = await store.list('key_x', { limit: 10 });
  assertEquals(left.map(m => m.id), ['01HZZ0000000000000000000A2']);

  const remainingFiles = await files.listKeys('dumps/v1/key_x/');
  assertEquals(remainingFiles.every(k => !k.includes('2026060109')), true);
});

test('FileDumpStore.purgeAll wipes every row and every file under the key prefix', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 9, 0, 0)));
  await store.put('key_x', baseRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await store.purgeAll('key_x');
  assertEquals((await store.list('key_x', { limit: 10 })).length, 0);
  assertEquals((await files.listKeys('dumps/v1/key_x/')).length, 0);
});

test('FileDumpStore.purgeExpired against a never-written key resolves without throwing', async () => {
  const db = await openDb();
  const files = new MemoryFileProvider();
  const store = new FileDumpStore(db, files);
  await store.purgeExpired('never_written_key', 3600);
  assertEquals((await store.list('never_written_key', { limit: 10 })).length, 0);
  assertEquals((await files.listKeys('dumps/v1/never_written_key/')).length, 0);
});
