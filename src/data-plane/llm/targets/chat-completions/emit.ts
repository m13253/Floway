import type {
  ChatCompletionChunk,
  ChatCompletionResponse,
  ChatCompletionsPayload,
} from "../../../shared/protocol/chat-completions.ts";
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
import { chatCompletionsStreamFramesToEvents } from "./events/from-stream.ts";
import { interceptorsForChatCompletions } from "./interceptors/index.ts";
import type { TelemetryModelIdentity } from "../../../../repo/types.ts";

const isSSEResponse = (response: Response): boolean =>
  (response.headers.get("content-type") ?? "").includes("text/event-stream");

export interface EmitToChatCompletionsInput
  extends EmitInput<ChatCompletionsPayload> {}

const chatCompletionsRawResultToProtocolResult = (
  result: RawEmitResult<ChatCompletionResponse>,
): EmitResult<ChatCompletionChunk> =>
  result.type === "events"
    ? eventResult(
      chatCompletionsStreamFramesToEvents(result.events),
      result.modelIdentity,
      result.performance,
    )
    : result;

export const emitToChatCompletions = async (
  input: EmitToChatCompletionsInput,
): Promise<EmitResult<ChatCompletionChunk>> => {
  let modelIdentity: TelemetryModelIdentity | undefined;
  try {
    const result = await runTargetInterceptors<
      EmitToChatCompletionsInput,
      ChatCompletionResponse
    >(
      input,
      interceptorsForChatCompletions(input),
      async () => {
        const upstreamStartedAt = performance.now();
        const { model: _model, ...body } = input.payload;
        const { response, modelKey } = await input.provider.callChatCompletions(
          input.upstreamModel,
          body,
          input.downstreamAbortSignal,
        );
        modelIdentity = {
          model: input.model,
          upstream: input.upstream,
          modelKey,
        };
        const perfContext = targetPerformanceContext(
          input,
          "chat-completions",
          modelIdentity,
        );

        if (!response.ok) {
          recordUpstreamHttpFailure(input, "chat-completions", modelIdentity);
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
              "chat-completions",
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
              "chat-completions",
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
              yield jsonFrame(await response.json() as ChatCompletionResponse);
            })(),
            input,
            "chat-completions",
            upstreamStartedAt,
            modelIdentity,
          ),
          modelIdentity,
          perfContext,
        );
      },
    );

    return chatCompletionsRawResultToProtocolResult(result);
  } catch (error) {
    return internalErrorResult(
      502,
      toInternalDebugError(error, input.sourceApi, "chat-completions"),
      modelIdentity
        ? targetPerformanceContext(input, "chat-completions", modelIdentity)
        : undefined,
    );
  }
};
