import { test } from 'vitest';

import { loadAllAliases } from './repo.ts';
import { createSqliteTestDb } from '../../repo/test-sqlite.ts';
import { assertEquals, assertRejects } from '@floway-dev/test-utils';

test('loadAllAliases reads the seed row from a freshly migrated database', async () => {
  const db = await createSqliteTestDb();

  const aliases = await loadAllAliases(db);

  assertEquals(aliases, [
    {
      alias: 'codex-auto-review',
      targetModelId: 'gpt-5.4',
      upstreamIds: [],
      rules: { reasoning: { effort: 'low' } },
      visibleInModelsList: true,
      onConflict: 'real-only',
    },
  ]);
});

test('loadAllAliases parses upstreamIds and rules JSON and coerces visible_in_models_list to a boolean', async () => {
  const db = await createSqliteTestDb();
  await db.exec('DELETE FROM model_aliases');
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind(
      'opus-xhigh',
      'claude-opus-4-6',
      '["up_priority","up_secondary"]',
      '{"reasoning":{"effort":"xhigh"},"anthropicBeta":["fine-grained-tool-streaming"]}',
      0,
      'alias-only',
    )
    .run();
  await db
    .prepare(
      'INSERT INTO model_aliases (alias, target_model_id, upstream_ids_json, rules_json, visible_in_models_list, on_conflict) VALUES (?, ?, ?, ?, ?, ?)',
    )
    .bind('gpt-5-fast', 'gpt-5.4', '[]', '{"serviceTier":"priority"}', 1, 'both-alias-first')
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
  });
  assertEquals(byAlias.get('gpt-5-fast'), {
    alias: 'gpt-5-fast',
    targetModelId: 'gpt-5.4',
    upstreamIds: [],
    rules: { serviceTier: 'priority' },
    visibleInModelsList: true,
    onConflict: 'both-alias-first',
  });
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
