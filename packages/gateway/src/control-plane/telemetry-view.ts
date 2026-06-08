import type { Context } from 'hono';

export type TelemetryView = 'all-by-user' | 'self-by-key';

// scopeUserId narrows with view: self-by-key always carries the actor's id;
// all-by-user has no per-user scope. The discriminated union lets callers
// drop a row of `!` non-null assertions on the self-by-key branch.
export type ResolvedTelemetryView =
  | { view: 'self-by-key'; scopeUserId: number }
  | { view: 'all-by-user' };

export type TelemetryViewError =
  | { error: 'forbidden'; message: string }
  | { error: 'bad_request'; message: string };

export const resolveTelemetryView = (
  c: Context,
  rawView: TelemetryView | undefined,
  rawKeyId: string | undefined,
): ResolvedTelemetryView | TelemetryViewError => {
  const userId = c.get('userId') as number;
  const canViewGlobal = c.get('canViewGlobalTelemetry') === true;

  const view = rawView ?? (canViewGlobal ? 'all-by-user' : 'self-by-key');

  if (view === 'all-by-user' && !canViewGlobal) {
    return {
      error: 'forbidden',
      message: 'You do not have permission to view global telemetry',
    };
  }
  if (view === 'all-by-user' && rawKeyId !== undefined && rawKeyId !== '') {
    return {
      error: 'bad_request',
      message: 'key_id is not allowed in all-by-user mode',
    };
  }

  return view === 'self-by-key'
    ? { view: 'self-by-key', scopeUserId: userId }
    : { view: 'all-by-user' };
};
