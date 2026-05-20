import type { TokenUsage } from "../../../../repo/types.ts";
import type { ResponsesResult } from "../../../shared/protocol/responses.ts";

export const tokenUsageFromResponsesResult = (
  response: ResponsesResult,
): TokenUsage | null =>
  response.usage
    ? {
      inputTokens: response.usage.input_tokens,
      outputTokens: response.usage.output_tokens,
      cacheReadTokens: response.usage.input_tokens_details?.cached_tokens ?? 0,
      cacheCreationTokens: 0,
    }
    : null;
