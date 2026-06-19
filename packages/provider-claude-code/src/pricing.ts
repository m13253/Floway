// Per-public-model pricing for the Claude Code (Claude.ai subscription)
// provider. Claude Code subscriptions bill as a flat fee rather than per
// token, but the dashboard tracks notional cost as if the operator were
// paying Anthropic's public API rates — so the operator can see whether a
// subscription is paying off relative to direct API spend.
//
// Values are USD per million tokens, aligned with the `Cost` schema in
// models.dev:
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
//
// Source of truth for Anthropic public API prices (verified 2026-06-19):
// https://console.anthropic.com/pricing — table reproduced inline below.
//
//   claude-sonnet-4-5  $3 input  / $0.30 cache_read / $3.75 cache_write / $15 output
//   claude-opus-4-5    $15 input / $1.50 cache_read / $18.75 cache_write / $75 output
//   claude-haiku-4-5   $1 input  / $0.10 cache_read / $1.25 cache_write / $5 output

import type { ModelPricing } from '@floway-dev/protocols/common';

const CLAUDE_CODE_MODEL_PRICING: Record<string, ModelPricing> = {
  'claude-sonnet-4-5-20250929': { input: 3, input_cache_read: 0.3, input_cache_write: 3.75, output: 15 },
  'claude-opus-4-5-20251101': { input: 15, input_cache_read: 1.5, input_cache_write: 18.75, output: 75 },
  'claude-haiku-4-5-20251001': { input: 1, input_cache_read: 0.1, input_cache_write: 1.25, output: 5 },
};

export const pricingForClaudeCodeModelKey = (modelKey: string): ModelPricing | null =>
  CLAUDE_CODE_MODEL_PRICING[modelKey] ?? null;
