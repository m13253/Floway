import { test } from 'vitest';

import { loadAllAliases, renameAlias } from './repo.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('loadAllAliases reads the seed row from a freshly migrated database', async () => {
  const db = await createSqliteTestDb();

  const aliases = await loadAllAliases(db);
  assertEquals(aliases.length, 1);
  const [seed] = aliases;
  // `createdAt` rides off the migration's `DEFAULT (unixepoch())`, so the
  // exact value is wall-clock dependent. Assert structurally that it landed
  // as a number and strip it before comparing the rest of the row.
  assertEquals(typeof seed.createdAt, 'number');
  const { createdAt: _createdAt, ...withoutTimestamp } = seed;
  assertEquals(withoutTimestamp, {
    alias: 'codex-auto-review',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: { reasoning: { effort: 'low' } },
    visibleInModelsList: true,
    onConflict: 'real-only',
    displayName: 'Codex Auto Review',
  });
});

test('loadAllAliases parses upstreamIds and rules JSON and coerces visible_in_models_list to a boolean', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind(
      'opus-xhigh',
      'claude-opus-4-6',
      '["up_priority","up_secondary"]',
      '{"reasoning":{"effort":"xhigh"},"anthropicBeta":["fine-grained-tool-streaming"]}',
      0,
      'alias-only',
      1_700_000_000,
    )
    .run();
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('gpt-5-fast', 'gpt-5.4', '[]', '{"serviceTier":"priority"}', 1, 'both-alias-first', 1_700_000_001)
    .run();

  const aliases = await loadAllAliases(db);
  const byAlias = new Map(aliases.map(entry => [entry.alias, entry]));

  assertEquals(byAlias.get('opus-xhigh'), {
    alias: 'opus-xhigh',
    targetModelId: 'claude-opus-4-6',
    upstreamIds: ['up_priority', 'up_secondary'],
    rules: { reasoning: { effort: 'xhigh' }, anthropicBeta: ['fine-grained-tool-streaming'] },
    visibleInModelsList: false,
    onConflict: 'alias-only',
    createdAt: 1_700_000_000,
  });
  assertEquals(byAlias.get('gpt-5-fast'), {
    alias: 'gpt-5-fast',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: { serviceTier: 'priority' },
    visibleInModelsList: true,
    onConflict: 'both-alias-first',
    createdAt: 1_700_000_001,
  });
});

test('loadAllAliases reads display_name and omits the field when SQL stored NULL', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('with-label', 'gpt-5.4', '[]', '{}', 1, 'real-only', 'Pretty Label', 1_700_000_000)
    .run();
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('no-label', 'gpt-5.4', '[]', '{}', 1, 'real-only', null, 1_700_000_001)
    .run();

  const byAlias = new Map((await loadAllAliases(db)).map(entry => [entry.alias, entry]));
  assertEquals(byAlias.get('with-label')?.displayName, 'Pretty Label');
  // SQL NULL becomes undefined on the typed row so callers can branch on `=== undefined`.
  assertEquals('displayName' in (byAlias.get('no-label') ?? {}), false);
});

test('loadAllAliases surfaces malformed rules_json as a descriptive error', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind('bad-rules', 'gpt-5.4', '[]', '{not json', 1, 'real-only')
    .run();

  await assertRejects(() => loadAllAliases(db), Error, 'Malformed model_aliases rules_json for bad-rules');
});

test('loadAllAliases surfaces malformed upstream_ids_json as a descriptive error', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind('bad-upstreams', 'gpt-5.4', '[bad', '{}', 1, 'real-only')
    .run();

  await assertRejects(() => loadAllAliases(db), Error, 'Malformed model_aliases upstream_ids_json for bad-upstreams');
});

test('renameAlias updates the PRIMARY KEY in place', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, display_name, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('source', 'gpt-5.4', '[]', '{}', 1, 'real-only', 'Source Label', 1_700_000_000)
    .run();

  const result = await renameAlias(db, 'source', 'renamed');
  assertEquals(result, { ok: true });

  const remaining = await loadAllAliases(db);
  assertEquals(remaining.map(a => a.alias), ['renamed']);
  // Preserved row payload — only the PK changed; createdAt and displayName intact.
  assertEquals(remaining[0]!.displayName, 'Source Label');
  assertEquals(remaining[0]!.createdAt, 1_700_000_000);
});

test('renameAlias returns notFound when the source row is missing', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  const result = await renameAlias(db, 'ghost', 'new-name');
  assertEquals(result, { ok: false, reason: 'notFound' });
});

test('renameAlias returns duplicate when the destination row already exists', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('source', 'gpt-5.4', '[]', '{}', 1, 'real-only', 1_700_000_000)
    .run();
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    )
    .bind('taken', 'gpt-5.4', '[]', '{}', 1, 'real-only', 1_700_000_001)
    .run();

  const result = await renameAlias(db, 'source', 'taken');
  assertEquals(result, { ok: false, reason: 'duplicate' });
  // Both rows still present.
  const remaining = (await loadAllAliases(db)).map(a => a.alias).sort();
  assertEquals(remaining, ['source', 'taken']);
});
