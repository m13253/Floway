import type { Context } from 'hono';

import { effectiveUpstreamIdsFromContext } from '../../../middleware/auth.ts';
import type { ApiKey } from '../../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { getCurrentColo } from '../../../runtime/runtime-info.ts';
import type { RespondObserver } from '../../shared/respond-observer.ts';
import { installRespondObservers } from '../../shared/respond-observer.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';

// Snapshot of the inbound request that the response-finalize hook hands to
// every observer. Captured at ctx construction so observers can produce a
// complete `RespondCapture` after the response settles, without re-reading a
// stream the handler has already consumed. The factory leaves these fields
// empty when no observer opted in for the request — we never carry bytes
// nobody reads.
export interface GatewayCtxRequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly contentType: string;
  readonly body: Uint8Array;
  readonly streamError: string | null;
}

export interface GatewayCtxRequestBody {
  readonly bytes: Uint8Array;
  readonly streamError?: string | null;
}

export interface GatewayCtx {
  readonly apiKeyId: string;
  readonly upstreamIds: readonly string[] | null;
  readonly abortSignal?: AbortSignal;
  readonly wantsStream: boolean;
  readonly downstreamAbortController?: AbortController;
  readonly backgroundScheduler: BackgroundScheduler;
  // Performance-clock stamp at ctx construction. Subtracted from a later
  // `performance.now()` to produce request-total latency telemetry.
  readonly requestStartedAt: number;
  // Wall-clock stamp at ctx construction (ms since epoch). Used by the dump
  // observer's `startedAt`/`durationMs` accounting, where `Date.now()` is the
  // right clock and `performance.now()` is not.
  readonly requestStartedWallMs: number;
  // The deployment colo / region, recorded as the `runtimeLocation` performance
  // dimension. Request-scoped, so it is resolved once here rather than at the
  // provider-call boundary.
  readonly runtimeLocation: string;
  readonly currentColo: string | null;
  // Cross-cutting observers installed at ctx construction from the request's
  // api key. The source-side respond layer (per-protocol `respond.ts` and
  // `passthrough-serve.ts`) emits lifecycle events to this list via
  // `notifyX(ctx, …)` — observers translate the events into their own
  // per-request state. Empty when no observer opted in (e.g. the api key has
  // no dump retention configured).
  readonly respondObservers: readonly RespondObserver[];
  // Inbound request snapshot for the observer `finalize` hook. Forward-passed
  // explicitly from the handler so the factory does not have to mutate
  // `c.req.raw` or carry hidden state on the Hono context.
  readonly requestSnapshot: GatewayCtxRequestSnapshot;
}

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => { pairs.push([name, value]); });
  return pairs;
};

const buildRequestSnapshot = (
  c: Context,
  body: GatewayCtxRequestBody | undefined,
  capture: boolean,
): GatewayCtxRequestSnapshot => {
  if (!capture) {
    return { method: c.req.method, path: c.req.path, headers: [], contentType: '', body: new Uint8Array(), streamError: null };
  }
  return {
    method: c.req.method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    contentType: c.req.header('content-type') ?? '',
    body: body?.bytes ?? new Uint8Array(),
    streamError: body?.streamError ?? null,
  };
};

const installObservers = (c: Context, startedAt: number): readonly RespondObserver[] => {
  // The auth middleware stamps `apiKey` on the context for every authenticated
  // data-plane request. Tests that don't model auth can leave it unset; the
  // factory then installs no observers (consistent with "no opt-in, no
  // observation").
  const apiKey = c.get('apiKey') as ApiKey | undefined;
  if (!apiKey) return [];
  return installRespondObservers({ apiKey, startedAt });
};

export const createGatewayCtxFromHono = (
  c: Context,
  wantsStream: boolean,
  requestBody?: GatewayCtxRequestBody,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const downstreamAbortController = wantsStream ? new AbortController() : undefined;
  const requestStartedAt = performance.now();
  const requestStartedWallMs = Date.now();
  const respondObservers = installObservers(c, requestStartedWallMs);
  return {
    apiKeyId,
    upstreamIds,
    ...(downstreamAbortController !== undefined ? { abortSignal: downstreamAbortController.signal, downstreamAbortController } : {}),
    wantsStream,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt,
    requestStartedWallMs,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    currentColo: getCurrentColo(c.req.raw),
    respondObservers,
    requestSnapshot: buildRequestSnapshot(c, requestBody, respondObservers.length > 0),
  };
};

export const createGatewayCtxForWs = (
  c: Context,
  downstreamAbortController: AbortController,
): GatewayCtx => {
  const apiKeyId = c.get('apiKeyId') as string;
  const upstreamIds = effectiveUpstreamIdsFromContext(c);
  const requestStartedAt = performance.now();
  const requestStartedWallMs = Date.now();
  const respondObservers = installObservers(c, requestStartedWallMs);
  return {
    apiKeyId,
    upstreamIds,
    abortSignal: downstreamAbortController.signal,
    wantsStream: true,
    downstreamAbortController,
    backgroundScheduler: backgroundSchedulerFromContext(c),
    requestStartedAt,
    requestStartedWallMs,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    currentColo: getCurrentColo(c.req.raw),
    respondObservers,
    // The WS upgrade carries no request body; the duplex frames flow after the
    // handshake. Observers that want WS-frame capture rely on the `frame`
    // hook, not on the inbound snapshot.
    requestSnapshot: buildRequestSnapshot(c, undefined, respondObservers.length > 0),
  };
};

// Reads `c.req.raw.body` in full into a Uint8Array, returning a stream-error
// summary instead of throwing when the read fails (a client that aborts a POST
// upload should still surface "request body didn't arrive" in the dump rather
// than producing a 500). Handlers pass the returned shape into
// `createGatewayCtxFromHono` AND parse their payload off the same bytes, so
// the inbound body is read exactly once.
export const readRequestBodyForCapture = async (c: Context): Promise<GatewayCtxRequestBody> => {
  if (c.req.raw.body === null) return { bytes: new Uint8Array(), streamError: null };
  try {
    return { bytes: new Uint8Array(await c.req.raw.arrayBuffer()), streamError: null };
  } catch (err) {
    const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
    return { bytes: new Uint8Array(), streamError: msg.length > 500 ? `${msg.slice(0, 497)}…` : msg };
  }
};
