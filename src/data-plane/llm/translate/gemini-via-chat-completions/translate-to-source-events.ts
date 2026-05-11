import { chatCompletionsErrorPayloadMessage } from "../../../../lib/chat-completions-errors.ts";
import type {
  ChatCompletionChunk,
  Delta,
} from "../../../../lib/chat-completions-types.ts";
import type {
  GeminiCandidate,
  GeminiFinishReason,
  GeminiGenerateContentResponse,
  GeminiPart,
  GeminiStreamEvent,
  GeminiUsageMetadata,
} from "../../../../lib/gemini-types.ts";
import { protocolEventsUntilTerminal } from "../../shared/stream/protocol-algebra.ts";
import { eventFrame, type ProtocolFrame } from "../../shared/stream/types.ts";
import { upstreamChatCompletionStreamAlgebra } from "../upstream-protocol.ts";

type ChatStreamChoice = ChatCompletionChunk["choices"][0];
type ChatToolCallDelta = NonNullable<Delta["tool_calls"]>[0];

interface ToolCallState {
  id?: string;
  name?: string;
  arguments: string;
}

interface ChoiceState {
  pendingThoughtSignature?: string;
  toolCalls: Record<number, ToolCallState>;
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const getChoiceState = (
  states: Record<number, ChoiceState>,
  index: number,
): ChoiceState => {
  states[index] ??= { toolCalls: {} };
  return states[index];
};

const appendPendingThoughtSignature = (
  state: ChoiceState,
  signature: string,
): void => {
  state.pendingThoughtSignature = `${
    state.pendingThoughtSignature ?? ""
  }${signature}`;
};

const attachPendingThoughtSignature = (
  part: GeminiPart,
  state: ChoiceState,
): GeminiPart => {
  if (state.pendingThoughtSignature === undefined) return part;

  const signedPart = {
    ...part,
    thoughtSignature: state.pendingThoughtSignature,
  };
  state.pendingThoughtSignature = undefined;
  return signedPart;
};

const mapFinishReason = (
  finishReason: ChatStreamChoice["finish_reason"],
): GeminiFinishReason | undefined => {
  switch (finishReason) {
    case "stop":
    case "tool_calls":
      return "STOP";
    case "length":
      return "MAX_TOKENS";
    case "content_filter":
      return "SAFETY";
    default:
      return undefined;
  }
};

const reasoningTokensFromUsage = (
  usage: NonNullable<ChatCompletionChunk["usage"]>,
): number | undefined => {
  const reasoningTokens = usage.completion_tokens_details?.reasoning_tokens;

  return typeof reasoningTokens === "number" ? reasoningTokens : undefined;
};

// OpenAI prompt_tokens already includes prompt_tokens_details.cached_tokens,
// matching Gemini's inclusive promptTokenCount semantics. Pass both through
// directly — no folding. Contrast with gemini-via-messages, where Anthropic's
// input_tokens excludes cache buckets and must be summed.
const mapUsage = (
  usage?: ChatCompletionChunk["usage"],
): GeminiUsageMetadata | undefined => {
  if (!usage) return undefined;

  const metadata: GeminiUsageMetadata = {
    promptTokenCount: usage.prompt_tokens,
    candidatesTokenCount: usage.completion_tokens,
    totalTokenCount: usage.total_tokens,
  };

  const thoughtsTokenCount = reasoningTokensFromUsage(usage);
  if (thoughtsTokenCount !== undefined) {
    metadata.thoughtsTokenCount = thoughtsTokenCount;
  }

  const cachedTokens = usage.prompt_tokens_details?.cached_tokens;
  if (cachedTokens !== undefined) {
    metadata.cachedContentTokenCount = cachedTokens;
  }

  return metadata;
};

const parseFunctionArgs = (
  toolCall: ToolCallState,
): Record<string, unknown> => {
  if (!toolCall.arguments) return {};

  let parsed: unknown;
  try {
    parsed = JSON.parse(toolCall.arguments) as unknown;
  } catch (error) {
    throw new Error(
      "Upstream Chat Completions tool call arguments were not valid JSON.",
      { cause: error },
    );
  }

  if (!isRecord(parsed)) {
    throw new Error(
      "Upstream Chat Completions tool call arguments must be a JSON object.",
    );
  }

  return parsed;
};

const accumulateToolCalls = (
  toolCalls: ChatToolCallDelta[],
  state: ChoiceState,
): void => {
  for (const toolCall of toolCalls) {
    const current = state.toolCalls[toolCall.index] ??= { arguments: "" };
    if (toolCall.id !== undefined) current.id = toolCall.id;
    if (toolCall.function?.name !== undefined) {
      current.name = toolCall.function.name;
    }
    if (toolCall.function?.arguments !== undefined) {
      current.arguments += toolCall.function.arguments;
    }
  }
};

const flushToolCallParts = (state: ChoiceState): GeminiPart[] => {
  const parts = Object.entries(state.toolCalls)
    .sort(([left], [right]) => Number(left) - Number(right))
    .flatMap(([_index, toolCall]) => {
      if (!toolCall.name) return [];

      const functionCall: GeminiPart["functionCall"] = {
        ...(toolCall.id !== undefined ? { id: toolCall.id } : {}),
        name: toolCall.name,
        args: parseFunctionArgs(toolCall),
      };

      return [attachPendingThoughtSignature({ functionCall }, state)];
    });

  state.toolCalls = {};
  return parts;
};

const buildCandidate = (
  choice: ChatStreamChoice,
  state: ChoiceState,
): GeminiCandidate | null => {
  const parts: GeminiPart[] = [];
  const { delta } = choice;

  if (typeof delta.reasoning_text === "string") {
    parts.push({ text: delta.reasoning_text, thought: true });
  }

  if (typeof delta.reasoning_opaque === "string") {
    appendPendingThoughtSignature(state, delta.reasoning_opaque);
  }

  if (typeof delta.content === "string") {
    parts.push(attachPendingThoughtSignature({ text: delta.content }, state));
  }

  if (delta.tool_calls) accumulateToolCalls(delta.tool_calls, state);

  const finishReason = mapFinishReason(choice.finish_reason);
  if (finishReason) {
    parts.push(...flushToolCallParts(state));
    if (state.pendingThoughtSignature !== undefined) {
      parts.push(attachPendingThoughtSignature({ text: "" }, state));
    }
  }

  if (!parts.length && !finishReason) return null;

  return {
    index: choice.index,
    content: { role: "model", parts },
    ...(finishReason ? { finishReason } : {}),
  };
};

const translateChunk = (
  chunk: ChatCompletionChunk,
  states: Record<number, ChoiceState>,
): GeminiGenerateContentResponse | null => {
  const candidates = chunk.choices.flatMap((choice) => {
    const candidate = buildCandidate(
      choice,
      getChoiceState(states, choice.index),
    );

    return candidate ? [candidate] : [];
  });
  const usageMetadata = mapUsage(chunk.usage);

  if (!candidates.length && !usageMetadata) return null;

  return {
    ...(candidates.length ? { candidates } : {}),
    ...(usageMetadata ? { usageMetadata } : {}),
  };
};

const mergeUsageIntoFinal = (
  finalResponse: GeminiGenerateContentResponse,
  usageMetadata?: GeminiUsageMetadata,
): void => {
  if (usageMetadata) finalResponse.usageMetadata = usageMetadata;
};

const appendFinalCandidates = (
  pendingFinalResponse: GeminiGenerateContentResponse | null,
  candidates: GeminiCandidate[],
  usageMetadata?: GeminiUsageMetadata,
): GeminiGenerateContentResponse => {
  const response = pendingFinalResponse ?? { candidates: [] };
  response.candidates = [...(response.candidates ?? []), ...candidates];
  mergeUsageIntoFinal(response, usageMetadata);
  return response;
};

const throwOnChatErrorPayload = (chunk: ChatCompletionChunk): void => {
  const message = chatCompletionsErrorPayloadMessage(chunk);
  if (!message) return;

  throw new Error(`Upstream Chat Completions stream error: ${message}`, {
    cause: chunk,
  });
};

export const translateToSourceEvents = async function* (
  frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
  const states: Record<number, ChoiceState> = {};
  let pendingUsageMetadata: GeminiUsageMetadata | undefined;
  let pendingFinalResponse: GeminiGenerateContentResponse | null = null;

  for await (
    const chunk of protocolEventsUntilTerminal(
      frames,
      upstreamChatCompletionStreamAlgebra,
    )
  ) {
    throwOnChatErrorPayload(chunk);

    const response = translateChunk(chunk, states);
    if (!response) continue;

    if (response.usageMetadata) {
      pendingUsageMetadata = response.usageMetadata;
      if (pendingFinalResponse) {
        mergeUsageIntoFinal(pendingFinalResponse, pendingUsageMetadata);
      }
    }

    const candidates = response.candidates ?? [];
    const finalCandidates = candidates.filter((candidate) =>
      candidate.finishReason !== undefined
    );
    const nonFinalCandidates = candidates.filter((candidate) =>
      candidate.finishReason === undefined
    );

    if (nonFinalCandidates.length) {
      yield eventFrame({ candidates: nonFinalCandidates });
    }

    if (finalCandidates.length) {
      pendingFinalResponse = appendFinalCandidates(
        pendingFinalResponse,
        finalCandidates,
        pendingUsageMetadata,
      );
    }
  }

  if (pendingFinalResponse) yield eventFrame(pendingFinalResponse);
};
