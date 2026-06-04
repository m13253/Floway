import type { SqlDatabase, SqlPreparedStatement, SqlResult } from '@floway-dev/platform';

// D1's runtime shape matches SqlDatabase exactly, so no adapter is needed —
// platform-cloudflare's bootstrap returns env.DB straight through. These
// aliases keep the CF-specific names available where it makes the binding
// surface read like Cloudflare docs (env types), while the proxy package
// only ever sees SqlDatabase.
export type D1Database = SqlDatabase;
export type D1PreparedStatement = SqlPreparedStatement;
export type D1Result<T = Record<string, unknown>> = SqlResult<T>;
