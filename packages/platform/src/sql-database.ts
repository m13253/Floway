// Minimal SQL database contract used by the proxy's repo layer. Cloudflare's
// D1 satisfies the shape directly. `meta.changes` is the only metadata field
// the contract requires; runtime-specific fields (D1's duration, rows_read,
// rows_written) intentionally stay out of the platform surface.
export interface SqlResult<T = Record<string, unknown>> {
  results: T[];
  success: boolean;
  meta: SqlResultMeta;
}

export interface SqlResultMeta {
  changes?: number;
}

export interface SqlPreparedStatement {
  bind(...values: unknown[]): SqlPreparedStatement;
  first<T = Record<string, unknown>>(): Promise<T | null>;
  all<T = Record<string, unknown>>(): Promise<SqlResult<T>>;
  run(): Promise<SqlResult>;
}

export interface SqlDatabase {
  prepare(query: string): SqlPreparedStatement;
  batch?(statements: SqlPreparedStatement[]): Promise<SqlResult[]>;
}
