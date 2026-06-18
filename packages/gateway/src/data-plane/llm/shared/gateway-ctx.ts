import type { Context } from 'hono';

import { effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  // Stamped at ctx construction so request-total latency telemetry can subtract
  // from `performance.now()` at response completion.
  readonly requestStartedAt: number;
  // The deployment colo / region, recorded as the `runtimeLocation` performance
  // dimension. Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  // The inbound client HTTP request the gateway is serving. Captured once at
  // ctx construction and forwarded to provider `call*` methods as the
  // `clientRequestHeaders` / `clientRequestPathname` UpstreamCallOptions
  // fields. Synthetic test contexts and non-Hono entry points leave these
  // undefined.
  readonly clientRequestHeaders?: Headers;
  readonly clientRequestPathname?: string;
}

// Names the auth-middleware-stamped Hono variables this builder reads. Hono
// gives no compile-time guarantee that a middleware ran; the alias is the
// local declaration of what `auth.ts` is contracted to set so the lookup
// sheds its inline cast.
export interface GatewayCtxAuthVars {
  apiKeyId: string;
  apiKeyUpstreamIds: readonly string[] | null;
  userUpstreamIds: readonly string[] | null;
}

type AuthedContext = Context<{ Variables: GatewayCtxAuthVars }>;

export const createGatewayCtxFromHono = (c: AuthedContext, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const url = new URL(c.req.url);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController?.signal,
    wantsStream,
    downstreamAbortController,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    clientRequestHeaders: c.req.raw.headers,
    clientRequestPathname: url.pathname,
  };
};

export const createGatewayCtxForWs = (
  c: AuthedContext,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId');
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const url = new URL(c.req.url);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    clientRequestHeaders: c.req.raw.headers,
    clientRequestPathname: url.pathname,
  };
};
