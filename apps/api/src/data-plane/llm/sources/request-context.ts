import type { Context } from 'hono';

import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { RequestContext } from '../interceptors.ts';

export const createHttpRequestContext = (c: Context, downstreamAbortSignal: AbortSignal | undefined, clientStream: boolean): RequestContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const apiKeyUpstreamIds = c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);
  return {
    requestStartedAt: performance.now(),
    ...(apiKeyId !== undefined ? { apiKeyId } : {}),
    apiKeyUpstreamIds: apiKeyUpstreamIds ?? null,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    ...(scheduleBackground !== undefined ? { scheduleBackground } : {}),
    clientStream,
    statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  };
};
