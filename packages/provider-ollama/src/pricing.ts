// Per-model notional pricing table for the Ollama provider. Ollama bills by
// subscription tier (Free / Pro / Max) on ollama.com and runs at zero
// upstream cost on a self-hosted deployment, neither of which is per-token.
// To keep the dashboard's "value consumed" view meaningful for an operator
// paying the subscription, the gateway tracks usage cost as if the operator
// were paying the cheapest credible commodity host (DeepInfra, Groq,
// DeepSeek, Moonshot, MiniMax, Z.ai, etc.) for the same open weights. Values
// are USD per million tokens, aligned with the `Cost` schema in models.dev:
// https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts
//
// Coverage: every model in https://ollama.com/search that has a published
// per-token price from a credible host. Models without a defensible reference
// (version names that don't map to any upstream release, sub-families with
// no host pricing, free-tier-only Labs SKUs whose pricing is non-commercial)
// are deliberately omitted — `pricingForOllamaModelKey` returns null and
// `usage.unit_price` is left NULL rather than fabricated.
//
// `input_cache_read` entries are intentional but DORMANT today: ollama.com
// internally caches prompt context (per its pricing FAQ, "prompts that share
// cached context use less"), but none of the three API surfaces
// (/v1/chat/completions, /api/chat, /v1/messages) currently exposes a cached-
// token count to clients. Without an upstream signal there is nothing to
// dimension a cache-read row against, so the rate sits unused. Leaving the
// commodity-host cache rates in the table keeps them ready the day Ollama
// surfaces cached_tokens — switching to billed cache reads then becomes a
// pure ingestion-side change.
//
// Refresh procedure: .agents/skills/refresh-ollama-pricing/.

import type { ModelPricing } from '@floway-dev/protocols/common';

type PricingRule = readonly [key: string | RegExp, pricing: ModelPricing];

const OLLAMA_MODEL_PRICING: readonly PricingRule[] = [
  // OpenAI gpt-oss — Groq publishes the cheapest mainstream rates with
  // cached-input support. https://groq.com/pricing
  ['gpt-oss:120b', { input: 0.15, input_cache_read: 0.075, output: 0.6 }],
  ['gpt-oss:20b', { input: 0.075, input_cache_read: 0.0375, output: 0.3 }],

  // Qwen3-Coder 480B — DeepInfra Turbo. DashScope tiers by context window
  // and runs 5×–15× higher; the commodity floor is the defensible anchor.
  // https://deepinfra.com/Qwen/Qwen3-Coder-480B-A35B-Instruct
  ['qwen3-coder:480b', { input: 0.3, output: 1.0 }],

  // Qwen3-Coder-Next — OpenRouter's `qwen/qwen3-coder-next` SKU. Distinct
  // from `qwen3-coder-flash` despite the size overlap; the Ollama tag maps
  // to the -next variant.
  // https://openrouter.ai/qwen/qwen3-coder-next
  ['qwen3-coder-next', { input: 0.11, input_cache_read: 0.07, output: 0.8 }],

  // Qwen 3.5 397B-a17b — Alibaba International first-party.
  // https://www.alibabacloud.com/help/en/model-studio/models
  ['qwen3.5:397b', { input: 0.6, output: 3.6 }],

  // DeepSeek — DeepSeek operates its own inference, so the first-party rate
  // is the floor for V3.2 and V4; V3.1 falls back to OpenRouter's dedicated
  // frozen-snapshot SKU since DeepSeek's `deepseek-chat` alias has since
  // rotated past it. https://api-docs.deepseek.com/quick_start/pricing
  ['deepseek-v3.1:671b', { input: 0.21, input_cache_read: 0.13, output: 0.79 }],
  ['deepseek-v3.2', { input: 0.23, output: 0.34 }],
  ['deepseek-v4-pro', { input: 0.435, input_cache_read: 0.003625, output: 0.87 }],
  ['deepseek-v4-flash', { input: 0.14, input_cache_read: 0.0028, output: 0.28 }],

  // GLM 4.7 — Z.ai first-party; OpenRouter and DeepInfra pass through at
  // the same rate. Don't extrapolate from 5.x; 4.7 is priced lower.
  // https://docs.z.ai/guides/llm
  ['glm-4.7', { input: 0.4, input_cache_read: 0.08, output: 1.75 }],

  // GLM 5.x — Z.ai first-party. Together / Fireworks pass through at similar
  // rates; Z.ai is the only fully-published source covering 5 / 5.1 / 5.2.
  // https://docs.z.ai/guides/llm
  [/^glm-5(\.[12])?$/, { input: 1.4, input_cache_read: 0.26, output: 4.4 }],

  // Kimi K2.x — Moonshot international API. K2.5 has a cheaper CN-only rate;
  // the international SKU is the defensible reference across regions.
  // https://platform.moonshot.ai/docs/pricing/chat
  ['kimi-k2.5', { input: 0.55, input_cache_read: 0.1, output: 2.9 }],
  ['kimi-k2.6', { input: 0.95, input_cache_read: 0.16, output: 4.0 }],
  ['kimi-k2.7-code', { input: 0.95, input_cache_read: 0.19, output: 4.0 }],

  // MiniMax — flat international rate across the M2 family and M3.
  // https://www.minimax.io/platform_overview
  [/^minimax-(m2(\.\d+)?|m3)$/, { input: 0.3, input_cache_read: 0.06, output: 1.2 }],

  // Mistral family — first-party `mistral-large-2512` and `devstral-2512`
  // are the priced sources; OpenRouter mirrors at the same rates. Ollama's
  // `mistral-large-3:675b` size suffix doesn't match any real Mistral
  // release (Large 3 isn't a 675B model), but the name match is
  // authoritative against the canonical Large 3 SKU.
  // https://mistral.ai/products/la-plateforme
  ['mistral-large-3:675b', { input: 0.5, output: 1.5 }],
  ['devstral-2:123b', { input: 0.4, output: 2.0 }],
  // `devstral-small-2:24b` is intentionally omitted: Mistral's only listed
  // SKU is the free Labs tier (no commercial pricing) and no commodity host
  // carries Devstral Small 2 at a paid rate. Persisting $0 would misrepresent
  // the upstream as zero-cost.

  // Ministral 3B / 8B — Mistral first-party. The 14B has no first-party SKU;
  // OpenRouter's `mistralai/ministral-14b-2512` is the only published source.
  // https://mistral.ai/products/la-plateforme
  ['ministral-3:3b', { input: 0.04, output: 0.04 }],
  ['ministral-3:8b', { input: 0.1, output: 0.1 }],
  ['ministral-3:14b', { input: 0.2, input_cache_read: 0.02, output: 0.2 }],

  // NVIDIA Nemotron-3 — DeepInfra hosts the Super; the Nano sits on
  // OpenRouter; the Ultra runs on DeepInfra / Together at higher rates.
  // NVIDIA itself has no public per-token API.
  // https://deepinfra.com/nvidia
  ['nemotron-3-nano:30b', { input: 0.05, output: 0.2 }],
  ['nemotron-3-super', { input: 0.1, output: 0.5 }],
  ['nemotron-3-ultra', { input: 0.6, input_cache_read: 0.15, output: 3.0 }],

  // Essential AI Rnj-1 — `essentialai/Rnj-1-Instruct` open weights, served
  // by Together and OpenRouter at a flat rate. The Ollama tag carries the
  // unconventional `rnj-1:8b` slug but maps cleanly to the upstream weights.
  // https://together.ai/models/essentialai/Rnj-1-Instruct
  ['rnj-1:8b', { input: 0.15, output: 0.15 }],

  // Gemini 3 Flash (preview) — Google AI Studio.
  // https://ai.google.dev/gemini-api/docs/pricing
  ['gemini-3-flash-preview', { input: 0.5, input_cache_read: 0.05, output: 3.0 }],

  // Gemma 3.x and Gemma 4 31B intentionally have no entries: Vertex AI sells
  // a per-token MaaS SKU only for `gemma-4-26b-a4b-it` ($0.15/$0.60/$0.015),
  // which Ollama Cloud does not carry. Every Gemma tag Ollama does carry runs
  // on Vertex Model Garden as a self-hosted GPU/TPU deployment (priced by
  // accelerator-hour, not tokens), and Ollama's pricing FAQ never quotes a
  // per-token rate for them. Leaving these unpriced rather than fabricating
  // an "AI Studio is free" zero — usage rows resolve to NULL unit_price.
  // https://cloud.google.com/vertex-ai/generative-ai/pricing — Gemma table
];

// Model keys persisted in `usage.model_key` for the Ollama provider are the
// raw upstream slugs from `GET /api/tags` (e.g. `gpt-oss:120b`,
// `deepseek-v4-flash`), with no variant-suffix munging — direct lookup
// against the table.
export const pricingForOllamaModelKey = (modelKey: string): ModelPricing | null => {
  for (const [key, pricing] of OLLAMA_MODEL_PRICING) {
    if (typeof key === 'string' ? modelKey === key : key.test(modelKey)) {
      return pricing;
    }
  }
  return null;
};
