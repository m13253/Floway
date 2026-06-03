import { responsesStreamFramesToEvents } from './events/from-stream.ts';
import { responsesBaseInterceptors } from './interceptors/index.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import { recordPerformanceLatency } from '../../../shared/telemetry/performance.ts';
import { type RequestContext, type ResponsesInvocation, runInterceptors } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { targetInternalError, targetModelIdentity, targetProviderResultToFrames, targetUpstreamErrorResult } from '../emit.ts';
import { targetPerformanceContext } from '../telemetry.ts';
import { doneFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import { responsesResultToEvents, type ResponsesPayload, type ResponsesResult, type RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

const targetApi = 'responses';

export const emitToResponses = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, ...body }: ResponsesPayload = invocation.payload;
      const providerResult = await invocation.provider.callResponses(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      const result = await targetProviderResultToFrames(invocation, request, targetApi, providerResult, modelIdentity, upstreamStartedAt);

      return result.type === 'events' ? eventResult(responsesStreamFramesToEvents(result.events), result.modelIdentity, result.performance, result.finalMetadata) : result;
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};

// `/responses/compact` is non-streaming: the provider yields the compaction
// envelope as a value, so we build the canonical event frames here — generic
// item expansion keeps the input-shaped retained messages intact — instead of
// re-parsing a synthesized SSE body. It runs the same interceptor stack as
// generation; only an upstream HTTP failure shares the streaming boundary's
// error handling. `stream` is dropped so the upstream request stays non-streaming.
export const emitToResponsesCompact = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<ProtocolFrame<RawResponsesStreamEvent>>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;

  try {
    return await runInterceptors(invocation, request, [...responsesBaseInterceptors, ...(invocation.targetInterceptors?.responses ?? [])], async () => {
      const upstreamStartedAt = performance.now();
      const { model: _model, stream: _stream, ...body } = invocation.payload;
      const providerResult = await invocation.provider.callResponsesCompact(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
      modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
      if (!providerResult.ok) return await targetUpstreamErrorResult(providerResult.response, invocation, request, targetApi, modelIdentity);

      const perfContext = targetPerformanceContext(invocation, request, targetApi, modelIdentity);
      if (request.apiKeyId) {
        const promise = recordPerformanceLatency(perfContext, 'upstream_success', performance.now() - upstreamStartedAt);
        request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
      }
      return eventResult(compactionFrames(providerResult.result), modelIdentity, perfContext);
    });
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, modelIdentity);
  }
};

const compactionFrames = (result: ResponsesResult): AsyncGenerator<ProtocolFrame<RawResponsesStreamEvent>> =>
  (async function* () {
    for (const frame of responsesResultToEvents(result, { genericOutputItems: true })) yield frame;
    yield doneFrame();
  })();
