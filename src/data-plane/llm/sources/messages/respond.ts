import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { MessagesStreamEventData } from "../../../../lib/messages-types.ts";
import {
  collectMessagesProtocolEventsToResponse,
} from "./events/to-response.ts";
import { messagesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { downstreamMessagesPingKeepAliveFrame } from "../../shared/stream/keep-alive.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { type ProtocolFrame, sseFrame } from "../../shared/stream/types.ts";
import {
  type PerformanceFailureCapture,
  withUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import {
  markPerformanceFailure,
  trackPerformanceOutcome,
} from "../performance.ts";

const internalMessagesErrorPayload = (error: InternalDebugError) => ({
  type: "error",
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

const internalMessagesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalMessagesErrorPayload(error), { status });

const internalMessagesStreamErrorFrame = (error: unknown) =>
  sseFrame(
    JSON.stringify(
      internalMessagesErrorPayload(toInternalDebugError(error, "messages")),
    ),
    "error",
  );

const isMessagesFailureEvent = (event: MessagesStreamEventData): boolean =>
  event.type === "error";

const isMessagesCompletionFrame = (
  frame: ProtocolFrame<MessagesStreamEventData>,
): boolean => frame.type === "event" && frame.event.type === "message_stop";

export const respondMessages = async (
  c: Context,
  result: StreamExecuteResult<MessagesStreamEventData>,
  wantsStream: boolean,
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
      internalMessagesErrorResponse(result.status, result.error),
      { performance: result.performance },
    );
  }

  if (!wantsStream) {
    const performanceFailureCapture: PerformanceFailureCapture = {};
    try {
      const response = await collectMessagesProtocolEventsToResponse(
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
        internalMessagesErrorResponse(
          502,
          toInternalDebugError(error, "messages"),
        ),
        {
          performance: result.performance,
          performanceFailureCapture,
        },
      );
    }
  }

  const performanceFailureCapture: PerformanceFailureCapture = {};
  const response = proxySSE(
    c,
    messagesProtocolEventsToSSEFrames(
      trackPerformanceOutcome(
        result.events,
        performanceFailureCapture,
        isMessagesFailureEvent,
        isMessagesCompletionFrame,
      ),
    ),
    {
      keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        markPerformanceFailure(performanceFailureCapture);
        return internalMessagesStreamErrorFrame(error);
      },
    },
  );

  return withUsageResponseMetadata(c, response, {
    usageModel: result.usageModel,
    performance: result.performance,
    performanceFailureCapture,
  });
};
