import type { TokenUsage } from "../../../../repo/types.ts";
import type {
  MessagesResponse,
  MessagesUsage,
} from "../../../shared/protocol/messages.ts";

export const tokenUsageFromMessagesUsage = (
  usage: MessagesUsage,
): TokenUsage => {
  const cacheReadTokens = usage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = usage.cache_creation_input_tokens ?? 0;
  return {
    inputTokens: usage.input_tokens + cacheReadTokens + cacheCreationTokens,
    outputTokens: usage.output_tokens,
    cacheReadTokens,
    cacheCreationTokens,
  };
};

export const tokenUsageFromMessagesResponse = (
  response: MessagesResponse,
): TokenUsage => tokenUsageFromMessagesUsage(response.usage);
