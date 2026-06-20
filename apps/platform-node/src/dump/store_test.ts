import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { test } from 'vitest';

import { FsFileProvider } from '../fs-file-provider.ts';
import { applyMigrations } from '../migrate.ts';
import { createNodeSqliteDatabase } from '../node-sqlite-database.ts';
import { FileDumpStore } from '@floway-dev/gateway';
import type { DumpRecord } from '@floway-dev/protocols/dump';
import { assertEquals, assertExists } from '@floway-dev/test-utils';

// FileDumpStore behavior is covered in gateway/src/repo/dump-store_test.ts
// against MemoryFileProvider; this smoke test verifies the Node-specific
// pairing (FsFileProvider + node:sqlite) so a regression in either node-only
// dependency surfaces here.

const sampleRecord = (id: string, completedAt: number): DumpRecord => ({
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

test('Node DumpStore: put + get round-trips through FsFileProvider + node:sqlite', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dump-store-'));
  const db = createNodeSqliteDatabase(join(root, 'db.sqlite'));
  await applyMigrations(db);
  try {
    const store = new FileDumpStore(db, new FsFileProvider(join(root, 'files')));
    await store.put('key_x', sampleRecord('01HZZ0000000000000000000A1', Date.UTC(2026, 5, 1, 12, 0, 0)));
    const fetched = await store.get('key_x', '01HZZ0000000000000000000A1');
    assertExists(fetched);
    assertEquals(fetched.request.body.data, '{"hello":"world"}');
    if (fetched.response.type !== 'bytes') throw new Error('expected bytes');
    assertEquals(fetched.response.body.data, '{"id":"abc"}');
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
