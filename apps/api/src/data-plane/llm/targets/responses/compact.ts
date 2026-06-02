import { emitToResponses } from './emit.ts';
import { recordPerformanceLatency } from '../../../shared/telemetry/performance.ts';
import { type RequestContext, type ResponsesInvocation } from '../../interceptors.ts';
import { eventResult, type ExecuteResult } from '../../shared/errors/result.ts';
import { readUpstreamError } from '../../shared/errors/upstream-error.ts';
import { targetInternalError, targetModelIdentity } from '../emit.ts';
import { recordUpstreamHttpFailure, targetPerformanceContext } from '../telemetry.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesResult, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

type Frame = ProtocolFrame<RawResponsesStreamEvent>;

const targetApi = 'responses';

// The native `/responses/compact` envelope marker. Both the native passthrough
// and the `context_management` realization answer the client under this object
// so a caller cannot tell which upstream mechanism produced the compaction.
const COMPACTION_OBJECT = 'response.compaction';

// `context_management` only sets WHEN compaction fires, not how aggressively;
// the floor the upstream accepts is 1000. We pin it at the floor so compaction
// triggers on the smallest qualifying context.
const COMPACT_THRESHOLD = 1000;

// Realizes `/responses/compact` against the resolved upstream. `endpoints.responses.compact`
// takes the native passthrough; otherwise `endpoints.responses.contextManagement`
// drives a `/responses` generation carrying the `context_management` parameter,
// whose compaction output item is the result. Both converge on a
// `response.compaction` envelope whose items flow through the shared source-serve
// store path, so the compaction blob persists with forced upstream affinity.
export const emitToResponsesCompact = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<Frame>> => {
  const responses = invocation.upstreamModel.endpoints.responses;
  if (responses?.compact) return await emitNativeCompact(invocation, request);
  return await emitContextManagementCompact(invocation, request);
};

const emitNativeCompact = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<Frame>> => {
  const startedAt = performance.now();
  try {
    const { model: _model, ...body }: ResponsesPayload = invocation.payload;
    const providerResult = await invocation.provider.callResponsesCompact(invocation.upstreamModel, body, request.downstreamAbortSignal, invocation.headers);
    const modelIdentity = targetModelIdentity(invocation, providerResult.modelKey);
    const perfContext = targetPerformanceContext(invocation, request, targetApi, modelIdentity);

    if (!providerResult.response.ok) {
      recordUpstreamHttpFailure(invocation, request, targetApi, modelIdentity);
      return { ...(await readUpstreamError(providerResult.response)), performance: perfContext };
    }

    const result = (await providerResult.response.json()) as ResponsesResult;
    if (request.apiKeyId) {
      const promise = recordPerformanceLatency(perfContext, 'upstream_success', performance.now() - startedAt);
      request.scheduleBackground ? request.scheduleBackground(promise) : void promise;
    }
    return eventResult(compactionResultToFrames(result), modelIdentity, perfContext);
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, undefined);
  }
};

const emitContextManagementCompact = async (invocation: ResponsesInvocation, request: RequestContext): Promise<ExecuteResult<Frame>> => {
  // `context_management` requires the model to finish a real turn before it
  // compacts, so we do NOT cap `max_output_tokens` — a small cap truncates the
  // turn and the upstream fails the compaction mid-stream. The generated
  // assistant turn is discarded; only the compaction item is retained.
  const payload: ResponsesPayload = { ...invocation.payload, context_management: [{ type: 'compaction', compact_threshold: COMPACT_THRESHOLD }] };
  const result = await emitToResponses({ ...invocation, payload }, request);
  if (result.type !== 'events') return result;

  try {
    const terminal = await drainToTerminalResponse(result.events);
    return eventResult(compactionResultToFrames(toCompactionEnvelope(terminal)), result.modelIdentity, result.performance, result.finalMetadata);
  } catch (error) {
    return targetInternalError(invocation, request, targetApi, error, result.modelIdentity);
  }
};

// Reshape a `context_management` generation's terminal response into the
// compaction envelope: keep only the `{type:"compaction"}` output item(s) and
// drop the discarded assistant turn (and any reasoning), then stamp the
// compaction object marker.
const toCompactionEnvelope = (terminal: ResponsesResult): ResponsesResult => ({
  ...terminal,
  object: COMPACTION_OBJECT,
  output: terminal.output.filter(item => item.type === 'compaction'),
});

// Drains an events result down to its terminal response. The fast-path
// expansion at the target boundary guarantees the terminal carries the full
// output, so reading it directly is sufficient — no incremental reassembly.
const drainToTerminalResponse = async (frames: AsyncIterable<Frame>): Promise<ResponsesResult> => {
  for await (const frame of frames) {
    if (frame.type !== 'event') continue;
    const event = frame.event;
    if (event.type === 'response.completed' || event.type === 'response.incomplete') return event.response;
    if (event.type === 'response.failed') throw new Error(`Responses compaction upstream failed: ${event.response.error?.message ?? 'unknown error'}`);
    if (event.type === 'error') throw new Error(`Responses compaction upstream error: ${(event as { message?: string }).message ?? 'unknown error'}`);
  }
  throw new Error('Responses compaction stream ended without a terminal response.');
};

// Synthesize the frame stream for a compaction envelope: emit each retained
// output item as an added/done carrier so the source-serve store layer mints a
// gateway id and persists it (the compaction blob forces upstream affinity for
// next-turn routing), then a terminal `response.completed` carrying the full
// envelope so the non-streaming respond reassembles the exact `response.compaction`
// body the client receives.
const compactionResultToFrames = (result: ResponsesResult): AsyncGenerator<Frame> =>
  (async function* () {
    let outputIndex = 0;
    for (const item of result.output) {
      yield eventFrame({ type: 'response.output_item.added', output_index: outputIndex, item } as RawResponsesStreamEvent);
      yield eventFrame({ type: 'response.output_item.done', output_index: outputIndex, item } as RawResponsesStreamEvent);
      outputIndex += 1;
    }
    yield eventFrame({ type: 'response.completed', response: result } as RawResponsesStreamEvent);
    yield doneFrame();
  })();
