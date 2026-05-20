import type { TokenUsage } from "../../../../repo/types.ts";
import type { ChatCompletionResponse } from "../../../shared/protocol/chat-completions.ts";

export const tokenUsageFromChatUsage = (
  usage: NonNullable<ChatCompletionResponse["usage"]>,
): TokenUsage => ({
  inputTokens: usage.prompt_tokens,
  outputTokens: usage.completion_tokens,
  cacheReadTokens: usage.prompt_tokens_details?.cached_tokens ?? 0,
  cacheCreationTokens: 0,
});

export const tokenUsageFromChatResponse = (
  response: ChatCompletionResponse,
): TokenUsage | null =>
  response.usage ? tokenUsageFromChatUsage(response.usage) : null;
