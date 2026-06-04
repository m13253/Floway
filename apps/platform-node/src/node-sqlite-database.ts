import { DatabaseSync, type StatementSync } from 'node:sqlite';

import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

// node:sqlite's prepared statement is synchronous and returns plain rows.
// We adapt it to the platform's async, enveloped contract: bind() captures
// values for the next call (matching D1's chained shape), run() reports
// `meta.changes` from the underlying result.
class NodeSqlitePreparedStatement implements SqlPreparedStatement {
  private bound: unknown[] = [];

  constructor(private readonly stmt: StatementSync) {}

  bind(...values: unknown[]): SqlPreparedStatement {
    this.bound = values;
    return this;
  }

  first<T = Record<string, unknown>>(): Promise<T | null> {
    const row = this.stmt.get(...(this.bound as never[]));
    return Promise.resolve((row as T | undefined) ?? null);
  }

  all<T = Record<string, unknown>>(): Promise<SqlResult<T>> {
    const rows = this.stmt.all(...(this.bound as never[])) as T[];
    return Promise.resolve({ results: rows, success: true, meta: {} });
  }

  run(): Promise<SqlResult> {
    const result = this.stmt.run(...(this.bound as never[]));
    return Promise.resolve({
      results: [],
      success: true,
      meta: { changes: Number(result.changes ?? 0) },
    });
  }
}

class NodeSqliteDatabase implements SqlDatabase {
  constructor(readonly raw: DatabaseSync) {}

  prepare(query: string): SqlPreparedStatement {
    return new NodeSqlitePreparedStatement(this.raw.prepare(query));
  }

  // batch() runs the supplied statements inside one transaction so the
  // multi-statement repo writes are atomic on this backend, matching D1's
  // batch semantics.
  async batch(statements: SqlPreparedStatement[]): Promise<SqlResult[]> {
    const results: SqlResult[] = [];
    this.raw.exec('BEGIN');
    try {
      for (const stmt of statements) results.push(await stmt.run());
      this.raw.exec('COMMIT');
    } catch (e) {
      this.raw.exec('ROLLBACK');
      throw e;
    }
    return results;
  }
}

// `raw` exposes the underlying DatabaseSync to bootstrap-time helpers in this
// package (the migration runner, which needs `exec()` to handle hand-authored
// migration files containing comments and trigger BEGIN/END blocks that
// statement-level prepare/run cannot parse).
export interface NodeSqliteDatabaseHandle extends SqlDatabase {
  readonly raw: DatabaseSync;
}

export const createNodeSqliteDatabase = (path: string): NodeSqliteDatabaseHandle => {
  const db = new DatabaseSync(path);
  // Match the schema's relational expectations; node:sqlite leaves foreign
  // key enforcement off by default while D1 keeps it on, so without this the
  // two backends drift.
  db.exec('PRAGMA foreign_keys = ON');
  return new NodeSqliteDatabase(db);
};
