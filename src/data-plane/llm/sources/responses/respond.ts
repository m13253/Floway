import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import {
  collectResponsesProtocolEventsToResult,
} from "./events/to-response.ts";
import { responsesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import type { SourceResponseStreamEvent } from "./events/protocol.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import { downstreamSSECommentKeepAliveFrame } from "../../shared/stream/keep-alive.ts";
import { type ProtocolFrame, sseFrame } from "../../shared/stream/types.ts";
import {
  type PerformanceFailureCapture,
  withUsageResponseMetadata,
} from "../../../../middleware/usage-response-metadata.ts";
import {
  markPerformanceFailure,
  trackPerformanceOutcome,
} from "../performance.ts";

const internalResponsesErrorPayload = (error: InternalDebugError) => ({
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

const internalResponsesErrorResponse = (
  status: number,
  error: InternalDebugError,
): Response => Response.json(internalResponsesErrorPayload(error), { status });

const internalResponsesStreamErrorFrame = (error: unknown) => {
  const debug = toInternalDebugError(error, "responses");

  return sseFrame(
    JSON.stringify({
      type: "error",
      message: debug.message,
      code: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    }),
    "error",
  );
};

const isResponsesFailureEvent = (event: SourceResponseStreamEvent): boolean =>
  event.type === "error" || event.type === "response.failed";

const isResponsesCompletionFrame = (
  frame: ProtocolFrame<SourceResponseStreamEvent>,
): boolean =>
  frame.type === "event" &&
  (frame.event.type === "response.completed" ||
    frame.event.type === "response.incomplete");

export const respondResponses = async (
  c: Context,
  result: StreamExecuteResult<SourceResponseStreamEvent>,
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
      internalResponsesErrorResponse(result.status, result.error),
      { performance: result.performance },
    );
  }

  const performanceFailureCapture: PerformanceFailureCapture = {};
  const events = trackPerformanceOutcome(
    result.events,
    performanceFailureCapture,
    isResponsesFailureEvent,
    isResponsesCompletionFrame,
  );

  if (!wantsStream) {
    try {
      const response = await collectResponsesProtocolEventsToResult(events);
      if (response.status === "failed") {
        markPerformanceFailure(performanceFailureCapture);
      }
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
        internalResponsesErrorResponse(
          502,
          toInternalDebugError(error, "responses"),
        ),
        {
          performance: result.performance,
          performanceFailureCapture,
        },
      );
    }
  }

  const response = proxySSE(
    c,
    responsesProtocolEventsToSSEFrames(events),
    {
      keepAlive: { frame: downstreamSSECommentKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        markPerformanceFailure(performanceFailureCapture);
        return internalResponsesStreamErrorFrame(error);
      },
    },
  );

  return withUsageResponseMetadata(c, response, {
    usageModel: result.usageModel,
    performance: result.performance,
    performanceFailureCapture,
  });
};
