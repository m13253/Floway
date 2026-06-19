// Per-public-model pricing table for the Codex (ChatGPT subscription)
// provider. Codex itself bills as a flat-fee subscription rather than per-token,
// but the gateway tracks usage cost as if the operator were paying OpenAI's
// public API rates — that lets the dashboard surface "value consumed vs. flat
// fee" so the operator can see whether a subscription is paying off relative
// to direct API spend. Values are USD per million tokens, aligned with
// the `Cost` schema in models.dev:
// https://github.com/anomalyco/models.dev/blob/8e6d393c01cb42d41a92f18725eef545e7190efb/packages/core/src/schema.ts
//
// Source of truth for OpenAI public API prices the table is derived from:
// https://openai.com/api/pricing/ (verified 2026-06-19 against the live tier
// breakdown at https://platform.openai.com/docs/pricing).
//
// Per-tier overrides cover the two service tiers Codex CLI exposes:
//   - `flex` (50% discount, slower) — set by `service_tier: "flex"` body field
//   - `priority` (premium for guaranteed latency) — Codex CLI's `/fast` toggle
//     writes `service_tier: "priority"` per
//     https://github.com/openai/codex/blob/main/codex-rs/protocol/src/config_types.rs
// OpenAI reports the actual tier used in `usage.service_tier` and the gateway
// captures it onto `TokenUsage.tier` so cost compute can pick the right row.
//
// Coverage: every slug surfaced by /codex/models for ChatGPT Plus today
// (gpt-5.5, gpt-5.4, gpt-5.4-mini, codex-auto-review). New slugs the upstream
// rolls out at higher plans (Pro / Team / Enterprise) should be added here so
// the dashboard reports their cost too.

import type { ModelPricing } from '@floway-dev/protocols/common';

const GPT_5_4_PRICING: ModelPricing = {
  input: 2.5,
  input_cache_read: 0.25,
  output: 15,
  tiers: {
    flex: { input: 1.25, input_cache_read: 0.13, output: 7.5 },
    priority: { input: 5, input_cache_read: 0.5, output: 30 },
  },
};

const CODEX_MODEL_PRICING: readonly (readonly [key: string | RegExp, pricing: ModelPricing])[] = [
  ['gpt-5.5', {
    input: 5,
    input_cache_read: 0.5,
    output: 30,
    tiers: {
      flex: { input: 2.5, input_cache_read: 0.25, output: 15 },
      priority: { input: 12.5, input_cache_read: 1.25, output: 75 },
    },
  }],
  ['gpt-5.4', GPT_5_4_PRICING],
  ['gpt-5.4-mini', {
    input: 0.75,
    input_cache_read: 0.075,
    output: 4.5,
    tiers: {
      flex: { input: 0.375, input_cache_read: 0.0375, output: 2.25 },
      priority: { input: 1.5, input_cache_read: 0.15, output: 9 },
    },
  }],
  // Internal review model gated under codex_cli_rs's auto-review feature; runs
  // on the same compute as gpt-5.4 and is billed identically (including tier
  // overrides — auto-review honors `service_tier` the same way).
  ['codex-auto-review', GPT_5_4_PRICING],
];

// Codex doesn't apply variant suffixes to model ids — the upstream's slug is
// the public id verbatim — so the modelKey persisted in `usage.model_key`
// matches the table key directly.
export const pricingForCodexModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of CODEX_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
