import type { GatewayCtx } from '../data-plane/chat/shared/gateway-ctx.ts';
import type { AuthedContext } from '../middleware/auth.ts';

// Minimal stub for the Hono `c` carried on `GatewayCtx`. Only `c.header`
// is touched by the serve layer (to stamp `x-floway-alias`); unit tests
// that don't exercise the alias branch never call it. Integration tests
// that need real Hono behavior build the ctx via `createGatewayCtxFromHono`
// against a real `makeApp()` request rather than going through this stub.
export const stubAuthedContext = (): AuthedContext =>
  ({ header: () => {} } as unknown as AuthedContext);

// Shared minimal GatewayCtx for tests that exercise serve / respond /
// interceptor code in isolation. Defaults satisfy every required field; pass
// `overrides` to nudge what each test cares about (wantsStream, apiKeyId,
// abortSignal, etc.). Callers that need a downstream abort controller should
// construct one and spread `{ abortSignal: controller.signal,
// downstreamAbortController: controller }` into the overrides.
export const mockGatewayCtx = (overrides: Partial<GatewayCtx> = {}): GatewayCtx => ({
  c: stubAuthedContext(),
  apiKeyId: 'key_test',
  upstreamIds: null,
  wantsStream: false,
  runtimeLocation: 'TEST',
  currentColo: 'TEST',
  dump: null,
  backgroundScheduler: promise => { void promise; },
  requestStartedAt: 0,
  responseHeaders: new Headers(),
  ...overrides,
});
