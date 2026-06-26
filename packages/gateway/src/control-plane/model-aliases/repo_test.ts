// Cross-backend tests for the model aliases repo. Memory drives the unit
// scenarios by default; the SQL backend (sql.js applying every migration)
// catches schema drift, JSON-column round-trips, and rename atomicity.

import { test } from 'vitest';

import { InMemoryRepo } from '../../repo/memory.ts';
import { SqlRepo } from '../../repo/sql.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import type { ModelAliasRecord, Repo } from '../../repo/types.ts';
import { assertEquals, assertExists, assertRejects } from '@floway-dev/test-utils';

const REPO_BACKENDS: Array<readonly [string, () => Promise<Repo>]> = [
  ['memory', async () => new InMemoryRepo()],
  ['sql', async () => new SqlRepo(await createSqliteTestDb())],
];

const aliasFixture = (overrides: Partial<ModelAliasRecord> = {}): ModelAliasRecord => ({
  name: 'gpt-fast',
  kind: 'chat',
  selection: 'first-available',
  displayName: null,
  visibleInModelsList: true,
  targets: [
    { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'low' } } },
  ],
  sortOrder: 0,
  createdAt: '2026-06-26T00:00:00.000Z',
  updatedAt: '2026-06-26T00:00:00.000Z',
  ...overrides,
});

for (const [backend, makeRepo] of REPO_BACKENDS) {
  // The 0046 migration seeds `codex-auto-review`; every test starts from a
  // known-empty state so assertions on row counts and ordering stay stable.
  const freshRepo = async (): Promise<Repo> => {
    const repo = await makeRepo();
    await repo.modelAliases.deleteAll();
    return repo;
  };

  test(`[${backend}] insert then list returns the row`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    const list = await repo.modelAliases.list();
    assertEquals(list.length, 1);
    assertEquals(list[0].name, 'gpt-fast');
    assertEquals(list[0].targets[0].target_model_id, 'gpt-5.4');
  });

  test(`[${backend}] insert collision throws`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    await assertRejects(() => repo.modelAliases.insert(aliasFixture()));
  });

  test(`[${backend}] getByName returns null when no row matches`, async () => {
    const repo = await freshRepo();
    assertEquals(await repo.modelAliases.getByName('nope'), null);
  });

  test(`[${backend}] update with same name preserves createdAt and refreshes updatedAt`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ createdAt: '2026-01-01T00:00:00.000Z', updatedAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.update('gpt-fast', aliasFixture({
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
      displayName: 'GPT Fast',
    }));
    const after = await repo.modelAliases.getByName('gpt-fast');
    assertExists(after);
    assertEquals(after.createdAt, '2026-01-01T00:00:00.000Z');
    assertEquals(after.updatedAt, '2026-06-26T12:00:00.000Z');
    assertEquals(after.displayName, 'GPT Fast');
  });

  test(`[${backend}] update with different name (rename) moves the row`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ createdAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.update('gpt-fast', aliasFixture({
      name: 'gpt-fastest',
      createdAt: '2026-01-01T00:00:00.000Z',
      updatedAt: '2026-06-26T12:00:00.000Z',
    }));
    assertEquals(await repo.modelAliases.getByName('gpt-fast'), null);
    const renamed = await repo.modelAliases.getByName('gpt-fastest');
    assertExists(renamed);
    assertEquals(renamed.createdAt, '2026-01-01T00:00:00.000Z');
  });

  test(`[${backend}] rename to an existing name throws and leaves both rows intact`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'gpt-fast' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'gpt-slow' }));
    await assertRejects(() => repo.modelAliases.update('gpt-fast', aliasFixture({ name: 'gpt-slow' })));
    assertExists(await repo.modelAliases.getByName('gpt-fast'));
    assertExists(await repo.modelAliases.getByName('gpt-slow'));
  });

  test(`[${backend}] update on a missing name throws`, async () => {
    const repo = await freshRepo();
    await assertRejects(() => repo.modelAliases.update('nope', aliasFixture({ name: 'nope' })));
  });

  test(`[${backend}] delete returns true when present, false when absent`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture());
    assertEquals(await repo.modelAliases.delete('gpt-fast'), true);
    assertEquals(await repo.modelAliases.delete('gpt-fast'), false);
  });

  test(`[${backend}] list orders by (sortOrder, createdAt)`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'a', sortOrder: 1, createdAt: '2026-01-01T00:00:00.000Z' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'b', sortOrder: 0, createdAt: '2026-02-01T00:00:00.000Z' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'c', sortOrder: 0, createdAt: '2026-01-15T00:00:00.000Z' }));
    const list = await repo.modelAliases.list();
    assertEquals(list.map(r => r.name), ['c', 'b', 'a']);
  });

  test(`[${backend}] targets JSON round-trips multi-target chat rules`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({
      name: 'multi',
      targets: [
        { target_model_id: 'gpt-5.4', rules: { reasoning: { effort: 'high', adaptive: true } } },
        { target_model_id: 'gpt-4.1', rules: { verbosity: 'low', serviceTier: 'priority' } },
        { target_model_id: 'gpt-3.5', rules: {} },
      ],
    }));
    const row = await repo.modelAliases.getByName('multi');
    assertExists(row);
    assertEquals(row.targets.length, 3);
    assertEquals(row.targets[0].rules, { reasoning: { effort: 'high', adaptive: true } });
    assertEquals(row.targets[1].rules, { verbosity: 'low', serviceTier: 'priority' });
    assertEquals(row.targets[2].rules, {});
  });

  test(`[${backend}] visibleInModelsList=false round-trips`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ visibleInModelsList: false }));
    const row = await repo.modelAliases.getByName('gpt-fast');
    assertEquals(row?.visibleInModelsList, false);
  });

  test(`[${backend}] deleteAll wipes every row`, async () => {
    const repo = await freshRepo();
    await repo.modelAliases.insert(aliasFixture({ name: 'a' }));
    await repo.modelAliases.insert(aliasFixture({ name: 'b' }));
    await repo.modelAliases.deleteAll();
    assertEquals((await repo.modelAliases.list()).length, 0);
  });
}
