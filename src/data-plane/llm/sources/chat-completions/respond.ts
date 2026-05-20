import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { ChatCompletionChunk } from "../../../shared/protocol/chat-completions.ts";
import { chatCompletionsErrorPayloadMessage } from "../../../shared/protocol/chat-completions-errors.ts";
import { collectChatProtocolEventsToCompletion } from "./events/reassemble.ts";
import { chatProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import {
  type ProtocolFrame,
  sseCommentFrame,
  sseFrame,
} from "../../shared/stream/types.ts";
import {
  type RecordRequestPerformance,
} from "../../../shared/telemetry/performance.ts";
import {
  type RecordUsage,
  recordUsageIfPresent,
} from "../../../shared/telemetry/usage.ts";
import {
  type SourceStreamOutcome,
  trackSourceStreamOutcome,
} from "../telemetry.ts";
import { tokenUsageFromChatResponse } from "./usage.ts";

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

const downstreamSSECommentKeepAliveFrame = sseCommentFrame("keepalive");

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
  recordUsage: RecordUsage,
  recordRequestPerformance: RecordRequestPerformance,
  requestStartedAt: number,
  downstreamAbortController?: AbortController,
): Promise<Response> => {
  const recordPerformance = (failed: boolean): void => {
    recordRequestPerformance(
      result.performance,
      failed,
      performance.now() - requestStartedAt,
    );
  };

  if (result.type === "upstream-error") {
    const response = upstreamErrorToResponse(result);
    recordPerformance(true);
    return response;
  }
  if (result.type === "internal-error") {
    const response = internalChatErrorResponse(result.status, result.error);
    recordPerformance(true);
    return response;
  }

  if (!wantsStream) {
    try {
      const response = await collectChatProtocolEventsToCompletion(
        result.events,
      );
      await recordUsageIfPresent(
        result.modelIdentity,
        tokenUsageFromChatResponse(response),
        recordUsage,
      );

      recordPerformance(false);
      return Response.json(response);
    } catch (error) {
      const response = internalChatErrorResponse(
        502,
        toInternalDebugError(error, "chat-completions"),
      );
      recordPerformance(true);
      return response;
    }
  }

  const streamOutcome: SourceStreamOutcome = {
    failed: false,
    completed: false,
  };

  const response = proxySSE(
    c,
    chatProtocolEventsToSSEFrames(
      trackSourceStreamOutcome(
        result.events,
        streamOutcome,
        isChatCompletionFailureEvent,
        isChatCompletionCompletionFrame,
      ),
      {
        includeUsageChunk,
        onUsage: (usage) => recordUsage(result.modelIdentity, usage),
      },
    ),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        streamOutcome.failed = true;
        return internalChatStreamErrorFrame(error);
      },
      onComplete: (completion) => {
        recordPerformance(
          completion === "error" || streamOutcome.failed ||
            (completion === "cancel" && !streamOutcome.completed),
        );
      },
    },
  );
  return response;
};
