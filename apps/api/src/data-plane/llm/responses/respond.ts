import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { RESPONSES_MISSING_TERMINAL_MESSAGE, collectResponsesProtocolEventsToResult } from './events/to-result.ts';
import { responsesProtocolFrameToSSEFrame } from './events/to-sse.ts';
import type { TokenUsage } from '../../../repo/types.ts';
import { recordRequestPerformanceForApiKey } from '../../shared/telemetry/performance.ts';
import { hasTokenUsage, recordTokenUsageForApiKey, tokenUsage } from '../../shared/telemetry/usage.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { SourceStreamState, eventResultMetadata, plainResultToResponse } from '../shared/respond.ts';
import { type StreamCompletion, writeSSEFrames } from '../shared/stream/proxy-sse.ts';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';
import { isResponsesTerminalEvent, type ResponsesResult, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { type ExecuteResult, type PlainResult, type InternalDebugError, type EventResultMetadata, type TelemetryModelIdentity, toInternalDebugError } from '@floway-dev/provider';
import { upstreamErrorToResponse } from '@floway-dev/provider';

type RE = ResponsesStreamEvent;
type RR = ResponsesResult;

// Renders an upstream Responses result into the client HTTP/SSE response. An
// error-typed result is a pre-stream failure and always answers as HTTP; an
// events result drains to one JSON body (non-streaming) or is proxied frame by
// frame (streaming). `success` reports whether a non-streaming body was
// produced, so the orchestrator knows whether to flush stored items.
export const respondResponses = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | PlainResult,
  wantsStream: boolean,
  ctx: GatewayCtx,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'upstream-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: upstreamErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordPerformance(ctx, result.performance, true);
    return { success: false, response: internalResponsesErrorResponse(result.status, result.error) };
  }

  if (result.type === 'plain') return { success: true, response: plainResultToResponse(result) };

  const state = new SourceStreamState();
  const frames = observeResponsesFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(frames);
      const metadata = await eventResultMetadata(result);
      await recordUsage(ctx, metadata.modelIdentity, tokenUsageFromResponsesResult(response));
      recordPerformance(ctx, metadata.performance, state.failed || response.status === 'failed');
      return { success: true, response: Response.json(response) };
    } catch (error) {
      recordPerformance(ctx, result.performance, true);
      return { success: false, response: internalResponsesErrorResponse(502, toInternalDebugError(error, 'responses')) };
    }
  }

  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, responsesSseFrames(frames, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        ...(ctx.downstreamAbortController !== undefined ? { downstreamAbortController: ctx.downstreamAbortController } : {}),
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordUsage(ctx, metadata.modelIdentity, state.usage);
      } finally {
        recordPerformance(ctx, metadata.performance, state.failedAfter(completion));
      }
    }
  });

  return { success: true, response };
};

// --- telemetry ---

// `GatewayCtx.apiKeyId` is `string | null`; the telemetry helpers accept
// `string | undefined` and skip on falsy. Coerce here to satisfy the signature
// without losing the no-op-on-missing-key behavior.
const recordUsage = async (ctx: GatewayCtx, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordTokenUsageForApiKey(ctx.apiKeyId ?? undefined, modelIdentity, usage);
};

const recordPerformance = (ctx: GatewayCtx, context: EventResultMetadata['performance'], failed: boolean): void => {
  // `GatewayCtx.scheduleBackground` takes a thunk returning Promise<void> | void;
  // the telemetry helper hands us a promise — adapt by returning it from the thunk
  // (the `Promise<unknown>` cast keeps TypeScript happy without inserting an await).
  const scheduler = (promise: Promise<unknown>) => ctx.scheduleBackground(() => promise as Promise<void>);
  recordRequestPerformanceForApiKey(ctx.apiKeyId ?? undefined, scheduler, context, failed, performance.now() - ctx.requestStartedAt);
};

// --- token usage ---

// OpenAI Responses reports input_tokens inclusive of cached tokens; subtract
// the cached split to recover the disjoint bare input.
const tokenUsageFromResponsesResult = (r: RR) => {
  const u = r.usage;
  if (!u) return null;
  const cacheRead = u.input_tokens_details?.cached_tokens ?? 0;
  return tokenUsage({
    input: u.input_tokens - cacheRead,
    input_cache_read: cacheRead,
    output: u.output_tokens,
  });
};

// --- error rendering ---

const internalResponsesErrorResponse = (status: number, error: InternalDebugError): Response =>
  Response.json({
    error: {
      type: error.type,
      name: error.name,
      message: error.message,
      stack: error.stack,
      cause: error.cause,
      source_api: error.source_api,
      target_api: error.target_api,
    },
  }, { status });

const internalResponsesStreamErrorFrame = (error: unknown) => {
  const debug = toInternalDebugError(error, 'responses');
  return sseFrame(
    JSON.stringify({
      type: 'error',
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    }),
    'error',
  );
};

// --- frame observation ---

const isResponsesTerminalFrame = (frame: ProtocolFrame<ResponsesStreamEvent>) => frame.type === 'event' && isResponsesTerminalEvent(frame.event);

const observeResponsesFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState, observeUsage: boolean) {
  const tokenUsageFromResponsesFrame = (f: ProtocolFrame<RE>) => (f.type === 'event' && 'response' in f.event ? tokenUsageFromResponsesResult((f.event as { response: RR }).response) : null);
  for await (const frame of frames) {
    const failed = frame.type === 'event' && (frame.event.type === 'error' || frame.event.type === 'response.failed');
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(tokenUsageFromResponsesFrame(frame));
    }
    if (isResponsesTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isResponsesTerminalFrame(frame)) return;
  }
  throw new Error(RESPONSES_MISSING_TERMINAL_MESSAGE);
};

const responsesSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = responsesProtocolFrameToSSEFrame(frame);
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield internalResponsesStreamErrorFrame(error);
  }
};
