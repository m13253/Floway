import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { ChatCompletionChunk } from "../../../../lib/chat-completions-types.ts";
import { chatCompletionsErrorPayloadMessage } from "../../../../lib/chat-completions-errors.ts";
import { collectChatProtocolEventsToCompletion } from "./events/to-response.ts";
import { chatProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { downstreamSSECommentKeepAliveFrame } from "../../shared/stream/keep-alive.ts";
import { type ProtocolFrame, sseFrame } from "../../shared/stream/types.ts";
import {
  type HiddenChatStreamUsageCapture,
  type PerformanceFailureCapture,
  withUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import {
  markPerformanceFailure,
  trackPerformanceOutcome,
} from "../performance.ts";

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

const internalChatErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalChatErrorPayload(error), { status });

const internalChatStreamErrorFrame = (error: unknown) =>
  sseFrame(
    JSON.stringify(
      internalChatErrorPayload(toInternalDebugError(error, "chat-completions")),
    ),
    "error",
  );

const isChatCompletionFailureEvent = (event: ChatCompletionChunk): boolean =>
  chatCompletionsErrorPayloadMessage(event) !== null;

const isChatCompletionCompletionFrame = (
  frame: ProtocolFrame<ChatCompletionChunk>,
): boolean => frame.type === "done";

export const respondChatCompletions = async (
  c: Context,
  result: StreamExecuteResult<ChatCompletionChunk>,
  wantsStream: boolean,
  includeUsageChunk: boolean,
  downstreamAbortController?: AbortController,
): Promise<Response> => {
  if (result.type === "upstream-error") {
    return withUsageResponseMetadata(c, upstreamErrorToResponse(result), {
      performance: result.performance,
    });
  }
  if (result.type === "internal-error") {
    return withUsageResponseMetadata(
      c,
      internalChatErrorResponse(result.status, result.error),
      { performance: result.performance },
    );
  }

  if (!wantsStream) {
    const performanceFailureCapture: PerformanceFailureCapture = {};
    try {
      const response = await collectChatProtocolEventsToCompletion(
        result.events,
      );

      return withUsageResponseMetadata(
        c,
        Response.json(response),
        {
          usageModel: result.usageModel,
          performance: result.performance,
          performanceFailureCapture,
        },
      );
    } catch (error) {
      markPerformanceFailure(performanceFailureCapture);

      return withUsageResponseMetadata(
        c,
        internalChatErrorResponse(
          502,
          toInternalDebugError(error, "chat-completions"),
        ),
        {
          performance: result.performance,
          performanceFailureCapture,
        },
      );
    }
  }

  const hiddenUsageCapture: HiddenChatStreamUsageCapture = {};
  const performanceFailureCapture: PerformanceFailureCapture = {};

  return withUsageResponseMetadata(
    c,
    proxySSE(
      c,
      chatProtocolEventsToSSEFrames(
        trackPerformanceOutcome(
          result.events,
          performanceFailureCapture,
          isChatCompletionFailureEvent,
          isChatCompletionCompletionFrame,
        ),
        {
          includeUsageChunk,
          onUsageChunk: (usage) => {
            hiddenUsageCapture.usage = usage;
          },
        },
      ),
      {
        keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
        downstreamAbortController,
        onError: (error) => {
          markPerformanceFailure(performanceFailureCapture);
          return internalChatStreamErrorFrame(error);
        },
      },
    ),
    {
      hiddenChatStreamUsageCapture: hiddenUsageCapture,
      usageModel: result.usageModel,
      performance: result.performance,
      performanceFailureCapture,
    },
  );
};
