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

export const createGatewayCtxFromHono = (c: Context, wantsStream: boolean): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const url = new URL(c.req.url);
  return {
    apiKeyId,
    upstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt: performance.now(),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    clientRequestHeaders: c.req.raw.headers,
    clientRequestPathname: url.pathname,
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  _server: WebSocket,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
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
