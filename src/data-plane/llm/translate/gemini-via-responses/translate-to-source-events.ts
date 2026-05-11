import type {
  GeminiFinishReason,
  GeminiPart,
  GeminiStreamEvent,
  GeminiUsageMetadata,
} from "../../../../lib/gemini-types.ts";
import type {
  ResponseOutputFunctionCall,
  ResponseOutputReasoning,
  ResponsesResult,
  ResponseStreamEvent,
} from "../../../../lib/responses-types.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import { upstreamResponsesStreamAlgebra } from "../upstream-protocol.ts";

type ResponseReasoningTextDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.reasoning_summary_text.delta" }
>;

type ResponseReasoningTextDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.reasoning_summary_text.done" }
>;

type ResponseOutputTextDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_text.delta" }
>;

type ResponseOutputTextDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_text.done" }
>;

type ResponseOutputItemAddedEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.added" }
>;

type ResponseOutputItemDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.output_item.done" }
>;

type ResponseFunctionArgumentsDeltaEvent = Extract<
  ResponseStreamEvent,
  { type: "response.function_call_arguments.delta" }
>;

type ResponseFunctionArgumentsDoneEvent = Extract<
  ResponseStreamEvent,
  { type: "response.function_call_arguments.done" }
>;

type ResponseTerminalEvent = Extract<
  ResponseStreamEvent,
  | { type: "response.completed" }
  | { type: "response.incomplete" }
  | { type: "response.failed" }
>;

type ResponseErrorEvent = Extract<ResponseStreamEvent, { type: "error" }>;

interface FunctionCallState {
  callId: string;
  name: string;
  arguments: string;
}

interface GeminiViaResponsesStreamState {
  pendingThoughtSignature?: string;
  functionCalls: Map<number, FunctionCallState>;
  emittedReasoningKeys: Set<string>;
  emittedTextKeys: Set<string>;
}

const createState = (): GeminiViaResponsesStreamState => ({
  pendingThoughtSignature: undefined,
  functionCalls: new Map(),
  emittedReasoningKeys: new Set(),
  emittedTextKeys: new Set(),
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const responsePartKey = (outputIndex: number, partIndex: number): string =>
  `${outputIndex}:${partIndex}`;

const appendPendingThoughtSignature = (
  state: GeminiViaResponsesStreamState,
  signature: string,
): void => {
  state.pendingThoughtSignature = `${
    state.pendingThoughtSignature ?? ""
  }${signature}`;
};

const attachPendingThoughtSignature = (
  part: GeminiPart,
  state: GeminiViaResponsesStreamState,
): GeminiPart => {
  if (state.pendingThoughtSignature === undefined) return part;

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  };
  state.pendingThoughtSignature = undefined;
  return signedPart;
};

const geminiResponse = (
  parts: GeminiPart[],
  finishReason?: GeminiFinishReason,
  usageMetadata?: GeminiUsageMetadata,
): GeminiStreamEvent => ({
  candidates: [{
    index: 0,
    content: { role: "model", parts },
    ...(finishReason !== undefined ? { finishReason } : {}),
  }],
  ...(usageMetadata !== undefined ? { usageMetadata } : {}),
});

// Responses input_tokens already includes input_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (
  usage: ResponsesResult["usage"],
): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  return {
    promptTokenCount: usage.input_tokens,
    candidatesTokenCount: usage.output_tokens,
    totalTokenCount: usage.total_tokens,
    ...(usage.output_tokens_details?.reasoning_tokens !== undefined
      ? {
        thoughtsTokenCount: usage.output_tokens_details.reasoning_tokens,
      }
      : {}),
    ...(usage.input_tokens_details?.cached_tokens !== undefined
      ? {
        cachedContentTokenCount: usage.input_tokens_details.cached_tokens,
      }
      : {}),
  };
};

const isSafetyFailure = (response: ResponsesResult): boolean => {
  const error = response.error;
  if (!error) return false;

  const text = `${error.type} ${error.code} ${error.message}`.toLowerCase();
  return text.includes("safety") || text.includes("content_filter") ||
    text.includes("policy");
};

const mapTerminalFinishReason = (
  event: ResponseTerminalEvent,
): GeminiFinishReason => {
  if (event.type === "response.completed") return "STOP";
  if (event.type === "response.failed") {
    return isSafetyFailure(event.response) ? "SAFETY" : "OTHER";
  }

  return event.response.incomplete_details?.reason === "max_output_tokens"
    ? "MAX_TOKENS"
    : "OTHER";
};

const parseFunctionArgs = (
  item: ResponseOutputFunctionCall,
  args: string,
): Record<string, unknown> => {
  if (!args) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(args) as unknown;
  } catch (error) {
    throw new Error(
      "Upstream Responses function call arguments were not valid JSON.",
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "Upstream Responses function call arguments must be a JSON object.",
    );
  }

  return parsed;
};

const emitTextPart = (
  part: GeminiPart,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent> =>
  eventFrame(geminiResponse([attachPendingThoughtSignature(part, state)]));

const handleReasoningText = (
  event: ResponseReasoningTextDeltaEvent | ResponseReasoningTextDoneEvent,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent>[] => {
  const text = event.type === "response.reasoning_summary_text.delta"
    ? event.delta
    : event.text;
  if (!text) return [];

  const key = responsePartKey(event.output_index, event.summary_index);
  if (event.type === "response.reasoning_summary_text.done") {
    if (state.emittedReasoningKeys.has(key)) return [];
  }

  state.emittedReasoningKeys.add(key);
  return [eventFrame(geminiResponse([{ text, thought: true }]))];
};

const handleText = (
  event: ResponseOutputTextDeltaEvent | ResponseOutputTextDoneEvent,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent>[] => {
  const text = event.type === "response.output_text.delta"
    ? event.delta
    : event.text;
  if (!text) return [];

  const key = responsePartKey(event.output_index, event.content_index);
  if (event.type === "response.output_text.done") {
    if (state.emittedTextKeys.has(key)) return [];
  }

  state.emittedTextKeys.add(key);
  return [emitTextPart({ text }, state)];
};

const rememberFunctionCall = (
  event: ResponseOutputItemAddedEvent,
  state: GeminiViaResponsesStreamState,
): void => {
  if (event.item.type !== "function_call") return;

  state.functionCalls.set(event.output_index, {
    callId: event.item.call_id,
    name: event.item.name,
    arguments: event.item.arguments,
  });
};

const handleFunctionArgumentsDelta = (
  event: ResponseFunctionArgumentsDeltaEvent,
  state: GeminiViaResponsesStreamState,
): void => {
  const current = state.functionCalls.get(event.output_index);
  if (!current) return;

  current.arguments += event.delta;
};

const handleFunctionArgumentsDone = (
  event: ResponseFunctionArgumentsDoneEvent,
  state: GeminiViaResponsesStreamState,
): void => {
  const current = state.functionCalls.get(event.output_index);
  if (!current) return;

  current.arguments = event.arguments;
};

const handleReasoningItemDone = (
  item: ResponseOutputReasoning,
  outputIndex: number,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent>[] => {
  const frames: ProtocolFrame<GeminiStreamEvent>[] = [];

  item.summary.forEach((part, summaryIndex) => {
    const key = responsePartKey(outputIndex, summaryIndex);
    if (!part.text || state.emittedReasoningKeys.has(key)) return;

    state.emittedReasoningKeys.add(key);
    frames.push(eventFrame(geminiResponse([{
      text: part.text,
      thought: true,
    }])));
  });

  if (
    Object.hasOwn(item, "encrypted_content") &&
    item.encrypted_content !== undefined
  ) {
    appendPendingThoughtSignature(state, item.encrypted_content);
  }

  return frames;
};

const handleFunctionCallDone = (
  item: ResponseOutputFunctionCall,
  outputIndex: number,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent>[] => {
  const current = state.functionCalls.get(outputIndex);
  state.functionCalls.delete(outputIndex);

  const args = current?.arguments || item.arguments;
  return [emitTextPart({
    functionCall: {
      id: current?.callId ?? item.call_id,
      name: current?.name ?? item.name,
      args: parseFunctionArgs(item, args),
    },
  }, state)];
};

const handleOutputItemDone = (
  event: ResponseOutputItemDoneEvent,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent>[] => {
  if (event.item.type === "reasoning") {
    return handleReasoningItemDone(event.item, event.output_index, state);
  }

  if (event.item.type === "function_call") {
    return handleFunctionCallDone(event.item, event.output_index, state);
  }

  return [];
};

const handleTerminal = (
  event: ResponseTerminalEvent,
  state: GeminiViaResponsesStreamState,
): ProtocolFrame<GeminiStreamEvent> => {
  const parts = state.pendingThoughtSignature !== undefined
    ? [attachPendingThoughtSignature({ text: "" }, state)]
    : [];

  return eventFrame(geminiResponse(
    parts,
    mapTerminalFinishReason(event),
    mapUsage(event.response.usage),
  ));
};

const throwOnResponsesErrorEvent = (event: ResponseErrorEvent): never => {
  throw new Error(`Upstream Responses stream error: ${event.message}`, {
    cause: event,
  });
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponseStreamEvent>>,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const state = createState();

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      upstreamResponsesStreamAlgebra,
    )
  ) {
    switch (event.type) {
      case "response.reasoning_summary_text.delta":
      case "response.reasoning_summary_text.done":
        yield* handleReasoningText(
          event as
            | ResponseReasoningTextDeltaEvent
            | ResponseReasoningTextDoneEvent,
          state,
        );
        break;

      case "response.output_text.delta":
      case "response.output_text.done":
        yield* handleText(
          event as ResponseOutputTextDeltaEvent | ResponseOutputTextDoneEvent,
          state,
        );
        break;

      case "response.output_item.added":
        rememberFunctionCall(event as ResponseOutputItemAddedEvent, state);
        break;

      case "response.function_call_arguments.delta":
        handleFunctionArgumentsDelta(
          event as ResponseFunctionArgumentsDeltaEvent,
          state,
        );
        break;

      case "response.function_call_arguments.done":
        handleFunctionArgumentsDone(
          event as ResponseFunctionArgumentsDoneEvent,
          state,
        );
        break;

      case "response.output_item.done":
        yield* handleOutputItemDone(
          event as ResponseOutputItemDoneEvent,
          state,
        );
        break;

      case "response.completed":
      case "response.incomplete":
      case "response.failed":
        yield handleTerminal(event as ResponseTerminalEvent, state);
        break;

      case "error":
        throwOnResponsesErrorEvent(event as ResponseErrorEvent);
        break;

      default:
        break;
    }
  }
};
