import type { Context } from "hono";
import {
  type InternalDebugError,
  toInternalDebugError,
} from "../../shared/errors/internal-debug-error.ts";
import type { MessagesStreamEventData } from "../../../shared/protocol/messages.ts";
import {
  collectMessagesProtocolEventsToResponse,
} from "./events/to-response.ts";
import { messagesProtocolEventsToSSEFrames } from "./events/to-sse.ts";
import { proxySSE } from "../../shared/stream/proxy-sse.ts";
import type { StreamExecuteResult } from "../../shared/errors/result.ts";
import { upstreamErrorToResponse } from "../../shared/errors/upstream-error.ts";
import { type ProtocolFrame, sseFrame } from "../../shared/stream/types.ts";
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
import { tokenUsageFromMessagesResponse } from "./usage.ts";

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

const downstreamMessagesPingKeepAliveFrame = sseFrame(
  JSON.stringify({ type: "ping" }),
  "ping",
);

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
    const response = internalMessagesErrorResponse(result.status, result.error);
    recordPerformance(true);
    return response;
  }

  if (!wantsStream) {
    try {
      const response = await collectMessagesProtocolEventsToResponse(
        result.events,
      );
      await recordUsageIfPresent(
        result.modelIdentity,
        tokenUsageFromMessagesResponse(response),
        recordUsage,
      );

      recordPerformance(false);
      return Response.json(response);
    } catch (error) {
      const response = internalMessagesErrorResponse(
        502,
        toInternalDebugError(error, "messages"),
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
    messagesProtocolEventsToSSEFrames(
      trackSourceStreamOutcome(
        result.events,
        streamOutcome,
        isMessagesFailureEvent,
        isMessagesCompletionFrame,
      ),
      {
        onUsage: (usage) => recordUsage(result.modelIdentity, usage),
      },
    ),
    {
      keepAlive: { frame: downstreamMessagesPingKeepAliveFrame },
      downstreamAbortController,
      onError: (error) => {
        streamOutcome.failed = true;
        return internalMessagesStreamErrorFrame(error);
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
