import type { ChatCompletionChunk } from "../../../../lib/chat-completions-types.ts";
import type {
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
import {
  createResponsesToChatCompletionsStreamState,
  translateResponsesEventToChatCompletionsChunks,
  translateResponsesToChatCompletion,
} from "../../../../lib/translate/responses-to-chat-completions.ts";
import {
  doneFrame,
  type EventFrame,
  eventFrame,
  type ProtocolFrame,
} from "../../shared/stream/types.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { chatCompletionResultToEvents } from "../../targets/chat-completions/events/from-result.ts";
import {
  upstreamResponsesStreamAlgebra,
  type UpstreamResponseStreamEvent,
} from "../upstream-protocol.ts";

interface ChatErrorPayload {
  error: {
    message: string;
    type: string;
    code?: string;
    name?: string;
    stack?: string;
    cause?: unknown;
    source_api?: string;
    target_api?: string;
  };
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null;

const stringField = (value: unknown, fallback: string): string =>
  typeof value === "string" && value.length > 0 ? value : fallback;

const debugFieldsFrom = (value: Record<string, unknown>) => ({
  ...(typeof value.name === "string" ? { name: value.name } : {}),
  ...(typeof value.stack === "string" ? { stack: value.stack } : {}),
  ...(value.cause !== undefined ? { cause: value.cause } : {}),
  ...(typeof value.source_api === "string"
    ? { source_api: value.source_api }
    : {}),
  ...(typeof value.target_api === "string"
    ? { target_api: value.target_api }
    : {}),
});

const chatErrorPayloadFromResponsesError = (
  event: Extract<ResponseStreamEvent, { type: "error" }>,
): ChatErrorPayload => ({
  error: {
    message: event.message,
    type: event.code ?? "api_error",
    ...(event.code ? { code: event.code } : {}),
    ...(event.name ? { name: event.name } : {}),
    ...(event.stack ? { stack: event.stack } : {}),
    ...(event.cause !== undefined ? { cause: event.cause } : {}),
    ...(event.source_api ? { source_api: event.source_api } : {}),
    ...(event.target_api ? { target_api: event.target_api } : {}),
  },
});

const chatErrorPayloadFromResponsesFailure = (
  event: Extract<ResponseStreamEvent, { type: "response.failed" }>,
): ChatErrorPayload => {
  const response = event.response as ResponsesResult;
  const error = isRecord(response.error) ? response.error : undefined;

  return {
    error: {
      message: stringField(
        error?.message,
        "Response failed due to unknown error.",
      ),
      type: stringField(error?.type, "api_error"),
      ...(typeof error?.code === "string" ? { code: error.code } : {}),
      ...(error ? debugFieldsFrom(error) : {}),
    },
  };
};

const chatErrorFrameFromResponsesFatalEvent = (
  event: ResponseStreamEvent,
): EventFrame<ChatCompletionChunk> | undefined => {
  if (event.type === "error") {
    // OpenAI-compatible Chat streams can carry top-level error payloads;
    // ChatCompletionChunk only models successful chunk payloads.
    return eventFrame(
      chatErrorPayloadFromResponsesError(
        event as Extract<ResponseStreamEvent, { type: "error" }>,
      ) as unknown as ChatCompletionChunk,
    );
  }

  if (event.type === "response.failed") {
    return eventFrame(
      chatErrorPayloadFromResponsesFailure(
        event as Extract<ResponseStreamEvent, { type: "response.failed" }>,
      ) as unknown as ChatCompletionChunk,
    );
  }

  return undefined;
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<UpstreamResponseStreamEvent>>,
): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
  const state = createResponsesToChatCompletionsStreamState();
  let sawStructuredOutput = false;
  let streamingCommitted = false;
  const pendingFrames: Array<EventFrame<ChatCompletionChunk>> = [];
  let yieldedDone = false;

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamResponsesStreamAlgebra,
    )
  ) {
    const failureFrame = chatErrorFrameFromResponsesFatalEvent(event);
    if (failureFrame) {
      yield failureFrame;
      return;
    }

    if (
      event.type === "response.output_item.added" ||
      event.type === "response.output_item.done" ||
      event.type === "response.reasoning_summary_text.delta" ||
      event.type === "response.output_text.delta" ||
      event.type === "response.function_call_arguments.delta"
    ) {
      sawStructuredOutput = true;
      if (!streamingCommitted) {
        streamingCommitted = true;
        for (const pending of pendingFrames) yield pending;
        pendingFrames.length = 0;
      }
    }

    if (
      !streamingCommitted &&
      !sawStructuredOutput &&
      (event.type === "response.completed" ||
        event.type === "response.incomplete")
    ) {
      pendingFrames.length = 0;
      for (
        const translated of chatCompletionResultToEvents(
          translateResponsesToChatCompletion(event.response as ResponsesResult),
        )
      ) {
        if (translated.type === "done") yieldedDone = true;
        yield translated;
      }
      continue;
    }

    const translated = translateResponsesEventToChatCompletionsChunks(
      event,
      state,
    );

    for (const chunk of translated) {
      const chunkFrame = eventFrame(chunk);
      if (streamingCommitted) {
        yield chunkFrame;
      } else {
        pendingFrames.push(chunkFrame);
      }
    }
  }

  if (!streamingCommitted && pendingFrames.length > 0) {
    for (const pending of pendingFrames) yield pending;
  }

  if (!yieldedDone) yield doneFrame();
};
