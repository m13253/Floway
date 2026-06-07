// Helper for /api/token-usage, /api/search-usage, /api/performance — resolves
// the requested view + capability gates.

import type { Context } from 'hono';

export type TelemetryView = 'all-by-user' | 'self-by-key';

export interface ResolvedTelemetryView {
  view: TelemetryView;
  // Set when the actor is in self-by-key mode; queries must scope to keys
  // belonging to this user (including soft-deleted ones, so a user's "my keys"
  // history still surfaces rows from rotated/removed keys).
  scopeUserId: number | null;
}

export type TelemetryViewError =
  | { error: 'forbidden'; message: string }
  | { error: 'bad_request'; message: string };

export const resolveTelemetryView = (
  c: Context,
  rawView: TelemetryView | undefined,
  rawKeyId: string | undefined,
): ResolvedTelemetryView | TelemetryViewError => {
  const userId = c.get('userId') as number;
  const isAdmin = c.get('isAdmin') === true;
  const canViewGlobal = c.get('canViewGlobalTelemetry') === true;

  const defaultView: TelemetryView = canViewGlobal ? 'all-by-user' : 'self-by-key';
  const view = rawView ?? defaultView;

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

  return {
    view,
    scopeUserId: view === 'self-by-key' ? userId : null,
    // isAdmin reserved for future per-user (`user:42`) drilldown queries.
    ...(isAdmin ? {} : {}),
  };
};
