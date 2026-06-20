// Structured event logging for the Claude Code provider, modeled on Go
// `log/slog` (and sub2api's usage of it): one line per event, a stable
// snake_case event name, and a flat bag of key=value fields. Operators
// can grep on the event name to slice a single state machine, and a
// trivial regex can pull the field values into a table for analysis.
//
// Format: `event_name field1=value1 field2="quoted with spaces"`.
// - Strings: bare when safe (no whitespace, no `=`, no `"`); JSON-quoted
//   otherwise so embedded quotes / spaces survive the round-trip.
// - Numbers and booleans: bare.
// - `null` / `undefined`: emitted as the literal `null` (so the operator
//   can see the field was considered and was absent, rather than missing).
//
// Format choice: KV over JSON-line because the gateway already emits a
// mix of free-form log lines and stack traces, and a KV line stays
// human-greppable on a terminal without a JSON pretty-printer. Both
// runtimes (Workers `console.*` and Node `console.*`) flush the line
// verbatim, so no third-party logger is involved — zero deps, identical
// behavior across the two deployment targets.
//
// Event-name convention: snake_case, prefixed with `claude_code_` so a
// single grep separates this provider's events from anything else in
// the worker log. Field names also snake_case for consistency with the
// event names and with the slog convention sub2api inherited.

export type LogFieldValue = string | number | boolean | null | undefined;
export type LogFields = Record<string, LogFieldValue>;

const NEEDS_QUOTING = /[\s"=]/;

const formatValue = (value: LogFieldValue): string => {
  if (value === null || value === undefined) return 'null';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === '' || NEEDS_QUOTING.test(value)) return JSON.stringify(value);
  return value;
};

const formatLogLine = (event: string, fields: LogFields): string => {
  const parts = [event];
  for (const [key, value] of Object.entries(fields)) {
    parts.push(`${key}=${formatValue(value)}`);
  }
  return parts.join(' ');
};

export const logInfo = (event: string, fields: LogFields = {}): void => {
  console.info(formatLogLine(event, fields));
};

export const logWarn = (event: string, fields: LogFields = {}): void => {
  console.warn(formatLogLine(event, fields));
};
