import type { Context } from 'hono';
import { streamSSE } from 'hono/streaming';

import { CHAT_COMPLETIONS_MISSING_DONE_MESSAGE } from './events/protocol.ts';
import { collectChatProtocolEventsToCompletion } from './events/to-response.ts';
import { chatProtocolFrameToSSEFrame } from './events/to-sse.ts';
import { tokenUsage } from '../../../shared/telemetry/usage.ts';
import type { RequestContext } from '../../interceptors.ts';
import { type InternalDebugError, toInternalDebugError } from '../../shared/errors/internal-debug-error.ts';
import type { ExecuteResult } from '../../shared/errors/result.ts';
import { upstreamErrorToResponse } from '../../shared/errors/upstream-error.ts';
import { type StreamCompletion, writeSSEFrames } from '../../shared/stream/proxy-sse.ts';
import { SourceStreamState, eventResultMetadata, recordSourcePerformance, recordSourceUsage } from '../respond.ts';
import type { ChatCompletionChunk, ChatCompletionResponse } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsErrorPayloadMessage } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame, sseCommentFrame, sseFrame } from '@floway-dev/protocols/common';

type CC = ChatCompletionChunk;
type CU = NonNullable<ChatCompletionResponse['usage']>;

// Renders an upstream Chat Completions result into the client HTTP/SSE
// response. An error-typed result is a pre-stream failure and always answers as
// HTTP; an events result drains to one JSON body (non-streaming) or is proxied
// frame by frame (streaming). `success` reports whether a non-streaming body was
// produced, so the orchestrator knows whether to flush stored items.
export const respondChatCompletions = async (
  c: Context,
  result: ExecuteResult<ProtocolFrame<ChatCompletionChunk>>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  request: RequestContext,
  downstreamAbortController: AbortController | undefined,
): Promise<{ success: boolean; response: Response }> => {
  if (result.type === 'upstream-error') {
    recordSourcePerformance(request, result.performance, true);
    return { success: false, response: upstreamErrorToResponse(result) };
  }

  if (result.type === 'internal-error') {
    recordSourcePerformance(request, result.performance, true);
    return { success: false, response: internalChatErrorResponse(result.status, result.error) };
  }

  const state = new SourceStreamState();
  const frames = observeChatFrames(result.events, state, wantsStream);

  if (!wantsStream) {
    try {
      const response = await collectChatProtocolEventsToCompletion(frames);
      const metadata = await eventResultMetadata(result);
      const usage = response.usage ? tokenUsageFromChatUsage(response.usage) : null;
      await recordSourceUsage(request, metadata.modelIdentity, usage);
      recordSourcePerformance(request, metadata.performance, state.failed);
      return { success: true, response: Response.json(response) };
    } catch (error) {
      recordSourcePerformance(request, result.performance, true);
      return { success: false, response: internalChatErrorResponse(502, toInternalDebugError(error, 'chat-completions')) };
    }
  }

  const response = streamSSE(c, async stream => {
    let completion: StreamCompletion = 'error';
    try {
      completion = await writeSSEFrames(stream, chatSseFrames(frames, includeUsageChunk, state), {
        keepAlive: { frame: sseCommentFrame('keepalive') },
        downstreamAbortController,
      });
    } finally {
      const metadata = await eventResultMetadata(result);
      try {
        await recordSourceUsage(request, metadata.modelIdentity, state.usage);
      } finally {
        recordSourcePerformance(request, metadata.performance, state.failedAfter(completion));
      }
    }
  });

  return { success: true, response };
};

// --- token usage ---

// OpenAI Chat usage reports prompt_tokens inclusive of cached and
// cache-creation tokens; subtract them to recover the disjoint bare input.
const tokenUsageFromChatUsage = (u: CU) => {
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
  return tokenUsage({
    input: u.prompt_tokens - cacheRead - cacheWrite,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: u.completion_tokens,
  });
};

// --- error rendering ---

const internalChatErrorPayload = (error: InternalDebugError) => ({
  error: {
    type: error.type,
    name: error.name,
    message: error.message,
    stack: error.stack,
    cause: error.cause,
    source_api: error.source_api,
    target_api: error.target_api,
  },
});

const internalChatErrorResponse = (status: number, error: InternalDebugError): Response => Response.json(internalChatErrorPayload(error), { status });

// --- frame observation ---

const isChatFailureFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'event' && chatCompletionsErrorPayloadMessage(frame.event) !== null;

const isChatTerminalFrame = (frame: ProtocolFrame<ChatCompletionChunk>) => frame.type === 'done' || isChatFailureFrame(frame);

const observeChatFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, state: SourceStreamState, observeUsage: boolean) {
  const tokenUsageFromChatFrame = (f: ProtocolFrame<CC>) =>
    f.type === 'event' && Array.isArray(f.event.choices) && f.event.choices.length === 0 && f.event.usage ? tokenUsageFromChatUsage(f.event.usage) : null;
  for await (const frame of frames) {
    const failed = isChatFailureFrame(frame);
    if (failed) state.failed = true;
    if (observeUsage) {
      state.rememberUsage(tokenUsageFromChatFrame(frame));
    }
    if (isChatTerminalFrame(frame) && !failed) state.completed = true;
    yield frame;
    if (isChatTerminalFrame(frame)) return;
  }
  throw new Error(CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

const chatSseFrames = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>, includeUsageChunk: boolean, state: SourceStreamState) {
  try {
    for await (const frame of frames) {
      const sse = chatProtocolFrameToSSEFrame(frame, { includeUsageChunk });
      if (sse) yield sse;
    }
  } catch (error) {
    state.failed = true;
    yield sseFrame(JSON.stringify(internalChatErrorPayload(toInternalDebugError(error, 'chat-completions'))), 'error');
  }
};
