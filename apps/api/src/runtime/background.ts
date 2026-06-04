import type { Context } from 'hono';

export type BackgroundScheduler = (promise: Promise<unknown>) => void;

// Returns undefined when Hono's `c.executionCtx` is not bound (test
// scenarios using `app.request(...)` directly, or any future runtime that
// satisfies the Web-API contract without a Workers ExecutionContext). The
// caller falls back to a synchronous no-op in that case — background work
// is best-effort telemetry, not request-critical.
export const backgroundSchedulerFromContext = (c: Context): BackgroundScheduler | undefined => {
  try {
    const executionCtx = c.executionCtx;
    return promise => executionCtx.waitUntil(promise);
  } catch {
    return undefined;
  }
};
