import { responsesStreamFramesToEvents } from './events/from-stream.ts';
import { responsesBaseInterceptors } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { ModelProvider, ProviderCallResult, UpstreamModel } from '../../../providers/types.ts';
import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames } from '../emit.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

const targetApi = 'responses';

type ResponsesProviderCall = (
  provider: ModelProvider,
  model: UpstreamModel,
  body: Omit<ResponsesPayload, 'model'>,
  signal: AbortSignal | undefined,
  headers: Record<string, string> | undefined,
) => Promise<ProviderCallResult>;

// `/responses` generation and `/responses/compact` share one target pipeline:
// both run the responses interceptor stack, hand the provider's SSE through the
// target boundary (which fast-path-expands a terminal-only stream), and surface
// the canonical event sequence. They differ only in the provider method called,
// so compaction never becomes a side path that bypasses interceptors — the
// provider layer is responsible for returning `text/event-stream` either way.
const emitResponsesVia = async (invocation: ResponsesInvocation, request: RequestContext, providerCall: ResponsesProviderCall): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ResponsesPayload = invocation.payload;
      const providerResult = await providerCall(invocation.provider, invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(responsesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};

export const emitToResponses = (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
  emitResponsesVia(invocation, request, (provider, model, body, signal, headers) => provider.callResponses(model, body, signal, headers));

export const emitToResponsesCompact = (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> =>
  emitResponsesVia(invocation, request, (provider, model, body, signal, headers) => {
    // `/responses/compact` is non-streaming on every realization, so a client
    // `stream: true` must never reach the upstream request body (the native
    // endpoint is contractually non-streaming; Copilot forces stream:false).
    const { stream: _stream, ...compactBody } = body;
    return provider.callResponsesCompact(model, compactBody, signal, headers);
  });
