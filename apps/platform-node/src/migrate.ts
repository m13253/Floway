import { readdir, readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import type { NodeSqliteDatabaseHandle } from './node-sqlite-database.ts';

// Resolve packages/proxy/migrations/ relative to this file's location in the
// workspace. The Node deployment target runs under tsx against the source
// tree, so the workspace layout is the source of truth — we walk three
// directories up from apps/platform-node/src/ to the workspace root, then
// down into packages/proxy/migrations/.
//
// We can't use require.resolve('@floway-dev/proxy/package.json') here because
// the proxy package's `exports` field intentionally exposes only its public
// surface; package.json is not subpath-exported and ESM resolution refuses
// undeclared subpaths.
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'packages', 'proxy', 'migrations');

export interface ApplyMigrationsOptions {
  // Override the migrations directory. Defaults to packages/proxy/migrations/
  // resolved via the workspace layout.
  dir?: string;
}

// Applies every pending migration in `dir`, recording each one's name in a
// `_migrations` table so reruns are no-ops. Each file's full contents go
// through node:sqlite's `exec()` rather than a hand-rolled statement split,
// because the migration corpus contains:
//   * trailing comment-only chunks that a `;` split turns into empty
//     statements, which `prepare()` rejects with "statement has been
//     finalized";
//   * `CREATE TRIGGER ... BEGIN ... END;` blocks whose embedded `;` characters
//     are part of the trigger body, which a regex split cannot honour.
// `exec()` is sqlite's native multi-statement entry point — the same one D1
// uses to apply migrations server-side.
//
// We bracket each file with our own BEGIN/COMMIT so a mid-file failure rolls
// the whole file back; without that bracket, the partial DDL from earlier
// statements would persist after a later one threw.
export const applyMigrations = async (
  db: NodeSqliteDatabaseHandle,
  options: ApplyMigrationsOptions = {},
): Promise<void> => {
  const dir = options.dir ?? DEFAULT_MIGRATIONS_DIR;
  db.raw.exec('CREATE TABLE IF NOT EXISTS _migrations (name TEXT PRIMARY KEY, applied_at INTEGER NOT NULL)');

  const appliedRows = await db.prepare('SELECT name FROM _migrations').all<{ name: string }>();
  const applied = new Set(appliedRows.results.map(r => r.name));

  const files = (await readdir(dir)).filter(f => f.endsWith('.sql')).toSorted();
  for (const file of files) {
    if (applied.has(file)) continue;
    const sql = await readFile(join(dir, file), 'utf8');

    db.raw.exec('BEGIN');
    try {
      db.raw.exec(sql);
      await db.prepare('INSERT INTO _migrations (name, applied_at) VALUES (?, ?)')
        .bind(file, Date.now()).run();
      db.raw.exec('COMMIT');
    } catch (e) {
      db.raw.exec('ROLLBACK');
      throw e;
    }
  }
};
