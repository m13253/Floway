import { recordUpstreamHttpFailure, targetPerformanceContext, withUpstreamTelemetry } from './telemetry.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import type { Invocation, RequestContext } from '../interceptors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type PerformanceApiName, type TelemetryModelIdentity, type ProviderStreamResult, type ExecuteResult, type InternalErrorResult, eventResult, internalErrorResult } from '@floway-dev/provider';
import { toInternalDebugError, readUpstreamError } from '@floway-dev/provider';

export type TargetEmitApiName = Exclude<PerformanceApiName, NonLlmServeApiName | 'gemini'>;

export const targetModelIdentity = (invocation: Invocation<unknown>, modelKey: string): TelemetryModelIdentity => ({
  model: invocation.model,
  upstream: invocation.upstream,
  modelKey,
  cost: invocation.provider.getPricingForModelKey(modelKey),
});

// Wraps a provider's ProviderStreamResult with telemetry + ExecuteResult
// boundary semantics: 2xx becomes an EventResult with upstream-success/error
// classification; non-2xx becomes an UpstreamErrorResult relayed verbatim.
// The provider has already decoded the SSE wire into ProtocolFrame<TEvent>,
// so this layer does not touch frame contents.
export const targetStreamResultToExecuteResult = async <TEvent>(
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: TargetEmitApiName,
  providerResult: ProviderStreamResult<TEvent>,
  modelIdentity: TelemetryModelIdentity,
  upstreamStartedAt: number,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const perfContext = targetPerformanceContext(invocation, request, targetApi, modelIdentity);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(invocation, request, targetApi, modelIdentity);
    return {
      ...(await readUpstreamError(providerResult.response)),
      performance: perfContext,
    };
  }

  return eventResult(
    withUpstreamTelemetry(providerResult.events, invocation, request, targetApi, upstreamStartedAt, modelIdentity),
    modelIdentity,
    perfContext,
  );
};

export const targetInternalError = (
  invocation: Invocation<unknown>,
  request: RequestContext,
  targetApi: TargetEmitApiName,
  error: unknown,
  modelIdentity: TelemetryModelIdentity | undefined,
): InternalErrorResult =>
  internalErrorResult(502, toInternalDebugError(error, invocation.sourceApi, targetApi), modelIdentity ? targetPerformanceContext(invocation, request, targetApi, modelIdentity) : undefined);
