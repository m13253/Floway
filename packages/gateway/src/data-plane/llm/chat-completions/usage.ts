import { billableServiceTier, tokenUsage } from '../../shared/telemetry/usage.ts';
import type { ChatCompletionsResult } from '@floway-dev/protocols/chat-completions';

// OpenAI Chat usage reports prompt_tokens inclusive of cached and
// cache-creation tokens; subtract them to recover the disjoint bare input.
// The top-level `service_tier` echoes the actual processing tier; surface it
// via `billableServiceTier` so per-tier pricing overrides resolve at
// recording time. https://developers.openai.com/api/docs/guides/priority-processing
export const tokenUsageFromChatCompletionsUsage = (u: NonNullable<ChatCompletionsResult['usage']>, serviceTier: string | null | undefined) => {
  const cacheRead = u.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWrite = u.prompt_tokens_details?.cache_creation_input_tokens ?? 0;
  return tokenUsage({
    input: u.prompt_tokens - cacheRead - cacheWrite,
    input_cache_read: cacheRead,
    input_cache_write: cacheWrite,
    output: u.completion_tokens,
    tier: billableServiceTier(serviceTier),
  });
};
