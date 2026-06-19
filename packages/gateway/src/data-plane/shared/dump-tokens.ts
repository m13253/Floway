import type { TokenUsage } from '../../repo/types.ts';

// Collapse a `TokenUsage` row into the single (input, output) pair the dump
// metadata carries. Every input-side dimension folds into `inputTokens`;
// every output-side dimension folds into `outputTokens`. Returns `null` when
// no usage was reported so the caller can stamp `null` on the dump record
// without inventing zeros.
export const sumDumpTokens = (usage: TokenUsage | null): { inputTokens: number; outputTokens: number } | null =>
  usage
    ? {
        inputTokens: (usage.input ?? 0) + (usage.input_cache_read ?? 0) + (usage.input_cache_write ?? 0) + (usage.input_image ?? 0),
        outputTokens: (usage.output ?? 0) + (usage.output_image ?? 0),
      }
    : null;
