import type { Context } from 'hono';

import { backgroundSchedulerFromContext, type BackgroundScheduler } from '../../../runtime/background.ts';
import { runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { RequestContext } from '../interceptors.ts';

export interface CreateRequestContextInput {
  apiKeyId?: string;
  apiKeyUpstreamIds?: readonly string[] | null;
  runtimeLocation: string;
  scheduleBackground?: BackgroundScheduler;
  downstreamAbortSignal?: AbortSignal;
  clientStream: boolean;
}

export const createRequestContext = (input: CreateRequestContextInput): RequestContext => ({
  requestStartedAt: performance.now(),
  ...(input.apiKeyId !== undefined ? { apiKeyId: input.apiKeyId } : {}),
  apiKeyUpstreamIds: input.apiKeyUpstreamIds ?? null,
  runtimeLocation: input.runtimeLocation,
  ...(input.scheduleBackground !== undefined ? { scheduleBackground: input.scheduleBackground } : {}),
  clientStream: input.clientStream,
  statefulResponsesContext: { privatePayload: new Map(), newSyntheticIds: new Set() },
  ...(input.downstreamAbortSignal !== undefined ? { downstreamAbortSignal: input.downstreamAbortSignal } : {}),
});

export const createHttpRequestContext = (c: Context, downstreamAbortSignal: AbortSignal | undefined, clientStream: boolean): RequestContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const apiKeyUpstreamIds = c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);
  return createRequestContext({
    ...(apiKeyId !== undefined ? { apiKeyId } : {}),
    ...(apiKeyUpstreamIds !== undefined ? { apiKeyUpstreamIds } : {}),
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    ...(scheduleBackground !== undefined ? { scheduleBackground } : {}),
    clientStream,
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  });
};
