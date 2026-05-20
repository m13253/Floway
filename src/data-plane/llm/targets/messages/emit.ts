import type {
  MessagesPayload,
  MessagesResponse,
  MessagesStreamEventData,
} from "../../../shared/protocol/messages.ts";
import { readUpstreamError } from "../../shared/errors/upstream-error.ts";
import {
  eventResult,
  internalErrorResult,
} from "../../shared/errors/result.ts";
import { toInternalDebugError } from "../../shared/errors/internal-debug-error.ts";
import { parseSSEStream } from "../../shared/stream/parse-sse.ts";
import { jsonFrame } from "../../shared/stream/types.ts";
import { runTargetInterceptors } from "../run-interceptors.ts";
import type { EmitInput, EmitResult, RawEmitResult } from "../emit-types.ts";
import {
  recordUpstreamHttpFailure,
  targetPerformanceContext,
  withUpstreamTelemetry,
} from "../telemetry.ts";
import { messagesStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForMessages } from "./interceptors/index.ts";
import type { TelemetryModelIdentity } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export interface EmitToMessagesInput extends EmitInput<MessagesPayload> {
  anthropicBeta?: readonly string[];
}

const messagesRawResultToProtocolResult = (
  result: RawEmitResult<MessagesResponse>,
): EmitResult<MessagesStreamEventData> =>
  result.type === "events"
    ? eventResult(
      messagesStreamFramesToEvents(result.events),
      result.modelIdentity,
      result.performance,
    )
    : result;

export const emitToMessages = async (
  input: EmitToMessagesInput,
): Promise<EmitResult<MessagesStreamEventData>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  try {
    input.payload.stream = true;

    const result = await runTargetInterceptors<
      EmitToMessagesInput,
      MessagesResponse
    >(
      input,
      interceptorsForMessages(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = input.payload;
        const { response, modelKey } = await input.provider.callMessages(
          input.upstreamModel,
          body,
          input.downstreamAbortSignal,
          input.anthropicBeta,
        );
        modelIdentity = {
          model: input.model,
          upstream: input.upstream,
          modelKey,
        };
        const perfContext = targetPerformanceContext(
          input,
          "messages",
          modelIdentity,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "messages", modelIdentity);
          return {
            ...(await readUpstreamError(response)),
            performance: perfContext,
          };
        }
        if (!response.body) {
          return internalErrorResult(
            502,
            toInternalDebugError(
              new Error("No response body from upstream"),
              input.sourceApi,
              "messages",
            ),
            perfContext,
          );
        }

        if (isSSEResponse(response)) {
          return eventResult(
            withUpstreamTelemetry(
              parseSSEStream(response.body, {
                signal: input.downstreamAbortSignal,
              }),
              input,
              "messages",
              upstreamStartedAt,
              modelIdentity,
            ),
            modelIdentity,
            perfContext,
          );
        }

        return eventResult(
          withUpstreamTelemetry(
            (async function* () {
              yield jsonFrame(await response.json() as MessagesResponse);
            })(),
            input,
            "messages",
            upstreamStartedAt,
            modelIdentity,
          ),
          modelIdentity,
          perfContext,
        );
      },
    );

    return messagesRawResultToProtocolResult(result);
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "messages"),
      modelIdentity
        ? targetPerformanceContext(input, "messages", modelIdentity)
        : undefined,
    );
  }
};
