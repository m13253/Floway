import { recordUpstreamHttpFailure, targetPerformanceContext, withUpstreamTelemetry } from './telemetry.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import type { SseFrame } from '@floway-dev/protocols/common';
import { type PerformanceApiName, type TelemetryModelIdentity, type ProviderCallResult, type ExecuteResult, type InternalErrorResult, eventResult, internalErrorResult } from '@floway-dev/provider';
import { toInternalDebugError, readUpstreamError } from '@floway-dev/provider';

export type TargetEmitApiName = Exclude<PerformanceApiName, NonLlmServeApiName | 'gemini'>;

export const targetModelIdentity = (invocation: Invocation<unknown>, modelKey: string): TelemetryModelIdentity => ({
  model: invocation.model,
  upstream: invocation.upstream,
  modelKey,
  cost: invocation.provider.getPricingForModelKey(modelKey),
});

export const targetProviderResultToFrames = async (
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: TargetEmitApiName,
  providerResult: ProviderCallResult,
  modelIdentity: TelemetryModelIdentity,
  upstreamStartedAt: number,
): Promise<ExecuteResult<SseFrame>> => {
  const perfContext = targetPerformanceContext(invocation, request, targetApi, modelIdentity);
  const { response } = providerResult;

  if (!response.ok) {
    recordUpstreamHttpFailure(invocation, request, targetApi, modelIdentity);
    return {
      ...(await readUpstreamError(response)),
      performance: perfContext,
    };
  }

  if (!response.body) {
    return internalErrorResult(502, toInternalDebugError(new Error('No response body from upstream'), invocation.sourceApi, targetApi), perfContext);
  }

  // Provider layer forces stream=true on every LLM endpoint, so any non-SSE
  // 200 response is a provider-contract violation: convert it to a 502 with
  // diagnostic context rather than silently parsing JSON. See
  // @floway-dev/provider's isStreamingEndpoint.
  const contentType = response.headers.get('content-type') ?? '';
  if (!contentType.includes('text/event-stream')) {
    recordUpstreamHttpFailure(invocation, request, targetApi, modelIdentity);
    return internalErrorResult(
      502,
      toInternalDebugError(
        new Error(`Upstream returned ${response.status} with content-type "${contentType || 'unknown'}" but stream is required (provider must force stream=true and return text/event-stream when response.ok)`),
        invocation.sourceApi,
        targetApi,
      ),
      perfContext,
    );
  }

  return eventResult(withUpstreamTelemetry(parseSSEStream(response.body, { signal: request.downstreamAbortSignal }), invocation, request, targetApi, upstreamStartedAt, modelIdentity), modelIdentity, perfContext);
};

export const targetInternalError = (
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: TargetEmitApiName,
  error: unknown,
  modelIdentity: TelemetryModelIdentity | undefined,
): InternalErrorResult =>
  internalErrorResult(502, toInternalDebugError(error, invocation.sourceApi, targetApi), modelIdentity ? targetPerformanceContext(invocation, request, targetApi, modelIdentity) : undefined);
