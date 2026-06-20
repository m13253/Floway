import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { createNodeDumpStore } from './store.ts';
import { FsFileProvider } from '../fs-file-provider.ts';
import { createNodeSqliteDatabase } from '../node-sqlite-database.ts';
import type { SqlDatabase } from '@floway-dev/platform';
import type { DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

const MIGRATION = `
CREATE TABLE dump_records (
  key_id TEXT NOT NULL,
  id TEXT NOT NULL,
  created_at INTEGER NOT NULL,
  meta_json TEXT NOT NULL,
  request_headers_json TEXT NOT NULL,
  response_headers_json TEXT,
  request_body_descriptor TEXT,
  response_body_descriptor TEXT,
  PRIMARY KEY (key_id, id)
);
CREATE INDEX idx_dump_records_key_created ON dump_records(key_id, created_at DESC);
`;

const withTempEnv = async (fn: (db: SqlDatabase, root: string) => Promise<void>): Promise<void> => {
  const root = await mkdtemp(join(tmpdir(), 'dump-store-'));
  const db = createNodeSqliteDatabase(join(root, 'db.sqlite'));
  await db.exec(MIGRATION);
  try {
    await fn(db, join(root, 'files'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
};

const sampleRecord = (id: string, completedAt: number): DumpRecord => ({
  meta: {
    id, startedAt: completedAt - 1, completedAt, method: 'POST', path: '/v1/x', status: 200,
    upstream: null, model: 'm', inputTokens: 1, outputTokens: 2,
    requestBytes: 3, responseBytes: 4, durationMs: 1, error: null,
  },
  request: {
    method: 'POST', path: '/v1/x',
    headers: [['content-type', 'application/json']],
    body: '{"hello":"world"}',
  },
  response: {
    status: 200,
    headers: [['content-type', 'application/json']],
    type: 'bytes',
    body: '{"id":"abc"}',
  },
});

test('Node DumpStore: end-to-end put + get + list against fs + node:sqlite', () => withTempEnv(async (db, root) => {
  const store = createNodeDumpStore(db, new FsFileProvider(root));
  await store.put('key_x', sampleRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await store.put('key_x', sampleRecord('01HZZ0000000000000000000A2', Date.UTC(2026, 5, 1, 12, 0, 1)));

  const list = await store.list('key_x', { limit: 10 });
  assertEquals(list.length, 2);
  assertEquals(list[0]!.id, '01HZZ0000000000000000000A2');

  const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
  assertExists(fetched);
  assertEquals(fetched.request.body, '{"hello":"world"}');
  if (fetched.response.type !== 'bytes') throw new Error('expected bytes');
  assertEquals(fetched.response.body, '{"id":"abc"}');
}));

test('Node DumpStore: purgeAll wipes rows and files together', () => withTempEnv(async (db, root) => {
  const files = new FsFileProvider(root);
  const store = createNodeDumpStore(db, files);
  await store.put('key_x', sampleRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0)));
  await store.purgeAll('key_x');
  assertEquals((await store.list('key_x', { limit: 10 })).length, 0);
  assertEquals((await files.listKeys('dumps/v1/key_x/')).length, 0);
}));
