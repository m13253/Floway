import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { FsFileProvider } from '../fs-file-provider.ts';
import { createNodeSqliteDatabase } from '../node-sqlite-database.ts';
import { NodeDumpStore } from './store.ts';
import type { DumpRecord } from '@floway-dev/protocols/dump';
import { assert, assertEquals } from '@floway-dev/test-utils';

const recordWith = (overrides: {
  id: string;
  startedAt: number;
  response: DumpRecord['response'];
}): DumpRecord => ({
  meta: {
    id: overrides.id,
    startedAt: overrides.startedAt,
    completedAt: overrides.startedAt + 50,
    method: 'POST',
    path: '/v1/messages?beta=1',
    status: 200,
    upstream: 'copilot',
    model: 'claude-3-5-sonnet',
    inputTokens: 12,
    outputTokens: 34,
    durationMs: 50,
    error: null,
  },
  request: {
    method: 'POST',
    path: '/v1/messages?beta=1',
    headers: [
      ['content-type', 'application/json'],
      ['x-api-key', 'secret'],
      ['accept', 'text/event-stream'],
    ],
    body: '{"hello":"world"}',
  },
  response: overrides.response,
});

const withStore = async (
  fn: (store: NodeDumpStore, setRetention: (keyId: string, retentionSeconds: number | null) => void) => Promise<void>,
): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), 'node-dump-store-'));
  try {
    const db = createNodeSqliteDatabase(join(dir, 'test.db'));
    await db.exec(
      'CREATE TABLE dump_records ('
      + '  key_id TEXT NOT NULL,'
      + '  id TEXT NOT NULL,'
      + '  meta_json TEXT NOT NULL,'
      + '  created_at INTEGER NOT NULL,'
      + '  PRIMARY KEY (key_id, id)'
      + ')',
    );
    const files = new FsFileProvider(join(dir, 'files'));
    const retentions = new Map<string, number | null>();
    const setRetention = (keyId: string, retentionSeconds: number | null): void => {
      retentions.set(keyId, retentionSeconds);
    };
    const store = new NodeDumpStore(db, files, async keyId => retentions.get(keyId) ?? null);
    await fn(store, setRetention);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

test('put/get round-trips a streaming-response record verbatim', () => withStore(async store => {
  const rec = recordWith({
    id: '01HXSTREAM000000000000',
    startedAt: 1_700_000_000_000,
    response: {
      status: 200,
      headers: [
        ['content-type', 'text/event-stream'],
        ['cache-control', 'no-store'],
      ],
      type: 'stream',
      events: [
        { event: 'message_start', data: '{"a":1}', ts: 0 },
        { event: null, data: 'ping', ts: 5 },
        { event: 'message_stop', data: '{"a":2}', ts: 10 },
      ],
    },
  });
  await store.put('key1', rec);
  assertEquals(await store.get('key1', rec.meta.id), rec);
}));

test('put/get round-trips a bytes-response record verbatim', () => withStore(async store => {
  const rec = recordWith({
    id: '01HXBYTES0000000000000',
    startedAt: 1_700_000_000_000,
    response: {
      status: 200,
      headers: [
        ['content-type', 'application/json'],
        ['set-cookie', 'a=1'],
        ['set-cookie', 'b=2'],
      ],
      type: 'bytes',
      body: 'eyJvayI6dHJ1ZX0=',
    },
  });
  await store.put('key1', rec);
  const round = await store.get('key1', rec.meta.id);
  assertEquals(round, rec);
  // Header order and duplicates must be preserved.
  assertEquals(round!.response.headers, rec.response.headers);
}));

test('put/get round-trips a none-response record verbatim', () => withStore(async store => {
  const rec = recordWith({
    id: '01HXNONE00000000000000',
    startedAt: 1_700_000_000_000,
    response: {
      status: 0,
      headers: [],
      type: 'none',
    },
  });
  await store.put('key1', rec);
  assertEquals(await store.get('key1', rec.meta.id), rec);
}));

test('get returns null for an unknown record id', () => withStore(async store => {
  assertEquals(await store.get('key1', '01HXMISSING00000000000'), null);
}));

test('list returns newest-first and respects limit', () => withStore(async store => {
  const ids = ['01HXAAA0000000000000A1', '01HXBBB0000000000000B2', '01HXCCC0000000000000C3'];
  for (let i = 0; i < ids.length; i++) {
    await store.put('key1', recordWith({
      id: ids[i]!,
      startedAt: 1_700_000_000_000 + i * 1000,
      response: { status: 200, headers: [], type: 'none' },
    }));
  }
  const all = await store.list('key1', { limit: 10 });
  assertEquals(all.map(m => m.id), [...ids].reverse());

  const capped = await store.list('key1', { limit: 2 });
  assertEquals(capped.map(m => m.id), [ids[2], ids[1]]);
}));

test('list before is strictly exclusive', () => withStore(async store => {
  const ids = ['01HXAAA0000000000000A1', '01HXBBB0000000000000B2', '01HXCCC0000000000000C3'];
  for (let i = 0; i < ids.length; i++) {
    await store.put('key1', recordWith({
      id: ids[i]!,
      startedAt: 1_700_000_000_000 + i * 1000,
      response: { status: 200, headers: [], type: 'none' },
    }));
  }
  const page = await store.list('key1', { before: ids[2], limit: 10 });
  assertEquals(page.map(m => m.id), [ids[1], ids[0]]);
}));

test('list caps the page size at 200', () => withStore(async store => {
  for (let i = 0; i < 205; i++) {
    const id = `01HXLIST${i.toString().padStart(16, '0')}`;
    await store.put('key1', recordWith({
      id,
      startedAt: 1_700_000_000_000 + i,
      response: { status: 200, headers: [], type: 'none' },
    }));
  }
  const page = await store.list('key1', { limit: 1000 });
  assertEquals(page.length, 200);
}));

test('list lazy-filters records older than the resolver retention before any sweep has run', () => withStore(async (store, setRetention) => {
  const now = Date.now();
  // Lower-lex id for the older record so list's newest-first ordering by id
  // matches the temporal order; otherwise the unfiltered assertion below
  // would assert on the wrong sequence.
  const stale = recordWith({
    id: '01HXLAZYA00OLD0000000A',
    startedAt: now - 7200_000,
    response: { status: 200, headers: [], type: 'none' },
  });
  const fresh = recordWith({
    id: '01HXLAZYZ00NEW0000000Z',
    startedAt: now - 100,
    response: { status: 200, headers: [], type: 'none' },
  });
  await store.put('key1', stale);
  await store.put('key1', fresh);

  // 1h retention hides the 2h-old record without us calling purgeExpired.
  setRetention('key1', 3600);
  const filtered = await store.list('key1', { limit: 10 });
  assertEquals(filtered.map(m => m.id), [fresh.meta.id]);

  // Same rows, no filter (null retention) — both come back, newest id first.
  setRetention('key1', null);
  const unfiltered = await store.list('key1', { limit: 10 });
  assertEquals(unfiltered.map(m => m.id), [fresh.meta.id, stale.meta.id]);
}));

test('get lazy-filters an expired record before any sweep has run', () => withStore(async (store, setRetention) => {
  const now = Date.now();
  const stale = recordWith({
    id: '01HXLAZYGET00000000000',
    startedAt: now - 7200_000,
    response: { status: 200, headers: [], type: 'none' },
  });
  await store.put('key1', stale);

  setRetention('key1', 3600);
  assertEquals(await store.get('key1', stale.meta.id), null);
  // Without a retention filter the same row is returned.
  setRetention('key1', null);
  assert((await store.get('key1', stale.meta.id)) !== null);
}));

test('list reflects a raised retention immediately (records within the new window become visible again)', () => withStore(async (store, setRetention) => {
  const now = Date.now();
  const tenMinutesOld = recordWith({
    id: '01HXRAISE000000000000A',
    startedAt: now - 600_000,
    response: { status: 200, headers: [], type: 'none' },
  });
  await store.put('key1', tenMinutesOld);

  // Under a 5-minute retention the 10-minute-old record is hidden,
  setRetention('key1', 300);
  assertEquals(await store.list('key1', { limit: 10 }), []);
  // but a raised retention exposes it on the very next read — no put or
  // sweep required in between.
  setRetention('key1', 86_400);
  const raised = await store.list('key1', { limit: 10 });
  assertEquals(raised.map(m => m.id), [tenMinutesOld.meta.id]);
}));

test('purgeExpired removes records older than now - retentionSeconds*1000 and keeps fresher ones', () => withStore(async store => {
  const retentionSeconds = 100;
  const now = Date.now();
  // Sit well outside the cutoff window so timing drift between this snapshot
  // and the one purgeExpired takes can't flip either record's classification.
  const old = recordWith({
    id: '01HXOLD000000000000000',
    startedAt: now - (retentionSeconds + 10) * 1000,
    response: { status: 200, headers: [], type: 'none' },
  });
  const fresh = recordWith({
    id: '01HXFRESH0000000000000',
    startedAt: now - 1000,
    response: { status: 200, headers: [], type: 'none' },
  });
  await store.put('key1', old);
  await store.put('key1', fresh);

  await store.purgeExpired('key1', retentionSeconds);

  assertEquals(await store.get('key1', old.meta.id), null);
  assert((await store.get('key1', fresh.meta.id)) !== null);

  const remaining = await store.list('key1', { limit: 10 });
  assertEquals(remaining.map(m => m.id), [fresh.meta.id]);
}));

test('purgeExpired keeps a record whose timestamp equals the cutoff (strict less-than)', () => withStore(async store => {
  // Place the record far in the future so the threshold strictly precedes
  // startedAt for any plausible Date.now() during the call: that's the
  // operational meaning of "boundary `=` is kept" — purge must not bite into
  // anything whose created_at is on or after the cutoff.
  const farFuture = Date.now() + 365 * 24 * 60 * 60 * 1000;
  const rec = recordWith({
    id: '01HXEDGE00000000000000',
    startedAt: farFuture,
    response: { status: 200, headers: [], type: 'none' },
  });
  await store.put('key1', rec);

  await store.purgeExpired('key1', 1);

  assert((await store.get('key1', rec.meta.id)) !== null);
}));

test('purgeAll removes every row and every file for the key', () => withStore(async store => {
  for (let i = 0; i < 3; i++) {
    await store.put('key1', recordWith({
      id: `01HXALL0000000000000${i}A`,
      startedAt: 1_700_000_000_000 + i,
      response: { status: 200, headers: [], type: 'none' },
    }));
  }
  await store.put('key2', recordWith({
    id: '01HXKEEP00000000000000',
    startedAt: 1_700_000_000_000,
    response: { status: 200, headers: [], type: 'none' },
  }));

  await store.purgeAll('key1');

  assertEquals(await store.list('key1', { limit: 10 }), []);
  // Other keys are untouched.
  const other = await store.list('key2', { limit: 10 });
  assertEquals(other.length, 1);
  assert((await store.get('key2', '01HXKEEP00000000000000')) !== null);
}));
