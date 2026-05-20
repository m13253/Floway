import type { TokenUsage } from "../../../../repo/types.ts";
import type {
  GeminiGenerateContentResponse,
  GeminiUsageMetadata,
} from "../../../shared/protocol/gemini.ts";

// Gemini usageMetadata.promptTokenCount already includes cachedContentTokenCount.
// thoughtsTokenCount is reasoning output and is not included in candidatesTokenCount,
// so include it in outputTokens to match the gateway's billing semantics.
export const tokenUsageFromGeminiUsageMetadata = (
  metadata: GeminiUsageMetadata,
): TokenUsage => ({
  inputTokens: metadata.promptTokenCount ?? 0,
  outputTokens: (metadata.candidatesTokenCount ?? 0) +
    (metadata.thoughtsTokenCount ?? 0),
  cacheReadTokens: metadata.cachedContentTokenCount ?? 0,
  cacheCreationTokens: 0,
});

export const tokenUsageFromGeminiResponse = (
  response: GeminiGenerateContentResponse,
): TokenUsage | null =>
  response.usageMetadata
    ? tokenUsageFromGeminiUsageMetadata(response.usageMetadata)
    : null;
