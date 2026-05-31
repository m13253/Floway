import type { Context } from 'hono';

import type { PerformanceApiName } from '../../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../../runtime/background.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import { type PerformanceTelemetryContext, runtimeLocationFromRequest } from '../../shared/telemetry/performance.ts';
import type { RequestContext } from '../interceptors.ts';
import { type LlmServeFailure } from './failure.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { internalErrorResult, type ExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, NonLlmServeApiName>;

export const createRequestContext = (c: Context, downstreamAbortSignal: AbortSignal | undefined, clientStream: boolean): RequestContext => {
  const apiKeyId = c.get('apiKeyId') as string | undefined;
  const apiKeyUpstreamIds = c.get('apiKeyUpstreamIds') as readonly string[] | null | undefined;
  const scheduleBackground = backgroundSchedulerFromContext(c);

  return {
    requestStartedAt: performance.now(),
    apiKeyId,
    apiKeyUpstreamIds: apiKeyUpstreamIds ?? null,
    runtimeLocation: runtimeLocationFromRequest(c.req.raw),
    scheduleBackground,
    clientStream,
    ...(downstreamAbortSignal !== undefined ? { downstreamAbortSignal } : {}),
  };
};

export const jsonUpstreamErrorResult = (status: number, body: unknown, performance?: PerformanceTelemetryContext): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
  ...(performance ? { performance } : {}),
});

const openAiModelErrorResult = (status: number, message: string) =>
  jsonUpstreamErrorResult(status, {
    error: { message, type: 'invalid_request_error' },
  });

export const openAiMissingModelResult = (model: string) => openAiModelErrorResult(404, `No upstream provides model ${model}. Configure an upstream that exposes this model in the dashboard.`);

export const openAiUnsupportedEndpointResult = (model: string, endpoint: string) => openAiModelErrorResult(400, `Model ${model} does not support the ${endpoint} endpoint.`);

export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
  },
): ExecuteResult<ProtocolFrame<TEvent>> => {
  const upstreamError = thrownUpstreamErrorResult(error);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi));
};

// OpenAI input-error envelope. `param`/`code` reproduce the native Responses
// error fields verbatim — a stored-item miss must byte-match OpenAI's own
// "not found" body, which downstream clients (codex) compare against.
const openAiInputErrorBody = (message: string, code: string | null) => ({
  error: { message, type: 'invalid_request_error' as const, param: 'input', code },
});

// The OpenAI-shaped half of the `LlmServeFailure` × source-protocol product:
// shared by the Responses and Chat Completions sources, which answer in the
// same envelope and differ only by endpoint label and telemetry tag.
export const renderOpenAiServeFailure = <TEvent>(
  failure: LlmServeFailure,
  options: { endpoint: string; sourceApi: PerformanceLlmSourceApi },
): ExecuteResult<ProtocolFrame<TEvent>> => {
  switch (failure.kind) {
  case 'item-not-found':
    return jsonUpstreamErrorResult(404, openAiInputErrorBody(`Item with id '${failure.itemId}' not found.`, null));
  case 'routing-unavailable':
    return jsonUpstreamErrorResult(400, openAiInputErrorBody(failure.message, 'responses_item_routing_unavailable'));
  case 'model-missing':
    return openAiMissingModelResult(failure.model);
  case 'model-unsupported':
    return openAiUnsupportedEndpointResult(failure.model, options.endpoint);
  case 'internal':
    return sourceErrorResult<TEvent>(failure.error, { sourceApi: options.sourceApi, internalStatus: 502 });
  }
};
