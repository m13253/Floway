---
name: refresh-ollama-pricing
description: Use when ollama.com's hosted catalog changes (new model lands, old
  one retires) or when an upstream price moves, to refresh
  packages/provider-ollama/src/pricing.ts. Manual — no script.
---

# Refresh Ollama Pricing

`OLLAMA_MODEL_PRICING` is notional: Ollama itself doesn't price per token, so
each entry mirrors the upstream the model would otherwise be paid on — the
vendor's own first-party API when the vendor operates one, or the cheapest
credible commodity host when the model is open-weights-only. Catalog churn
is weekly, so re-validate periodically.

## Flow

1. **Pull the live catalog.**
   `curl -s https://ollama.com/api/tags | jq -r '.models[].name' | sort`
   Diff against the string keys + regex coverage in
   `packages/provider-ollama/src/pricing.ts`. Note new models, retired
   models, and entries whose family no longer appears upstream.

2. **Identify the upstream lane for each new model.** First-party API takes
   precedence over commodity-host mirrors (DeepSeek, Z.ai, Moonshot,
   MiniMax, Mistral, Alibaba, Google all run their own APIs and publish
   per-token rates). Mirrors (DeepInfra, Together, Fireworks, OpenRouter)
   are only the right anchor for open-weights-only releases (OpenAI's
   gpt-oss, NVIDIA's Nemotron, Essential AI's Rnj-1).

   | Family | Anchor |
   |---|---|
   | `gpt-oss:*` | Groq (cheapest commodity host with cached-input pricing) |
   | `qwen*` | Alibaba International first-party (`qwencloud.com/models/<id>`); fall back to DeepInfra Turbo only when Alibaba doesn't publish a SKU |
   | `deepseek-v*` | DeepSeek first-party (`api-docs.deepseek.com/quick_start/pricing`); for past versions whose `deepseek-chat` alias has rotated, use Wayback snapshots from the period the version was current |
   | `glm-*` | Z.ai first-party (`docs.z.ai/guides/overview/pricing`) |
   | `kimi-*` | Moonshot international (`platform.moonshot.ai/docs/pricing/chat`) |
   | `minimax-*` | MiniMax international PAYGo (`platform.minimax.io/docs/guides/pricing-paygo`) |
   | `mistral-large-*` / `devstral-*` / `ministral-*` | Mistral first-party (`mistral.ai/pricing`) |
   | `nemotron-3-*` | DeepInfra (cheapest commodity host) |
   | `gemini-*` | Google AI Studio (`ai.google.dev/gemini-api/docs/pricing`) |
   | `gemma*` | Vertex AI sells per-token only for `gemma-4-26b-a4b-it`; every other Gemma tag is GPU-hour self-host. Leave NULL. |
   | `rnj-*` | Together (Essential AI doesn't run an API of its own) |

3. **Verify against multiple sources before writing.** Cross-check the
   first-party rate against models.dev's catalog
   (`curl -s https://models.dev/api.json | jq '.<provider>.models["<id>"].cost'`)
   and against OpenRouter's `/api/v1/models`. OpenRouter rates that sit
   *below* first-party are mirror prices (some other host running the open
   weights more cheaply) and are NOT the canonical anchor — the same
   first-party-vs-mirror split that bit DeepSeek V3.x and Qwen3-Coder-Next
   in earlier passes. Use first-party.

4. **Edit `pricing.ts`.** Add/update entries with `input`,
   `input_cache_read` (when the upstream publishes one), `output`. Group
   exact string keys; use a regex only when several versions genuinely share
   a single rate. Cite the source URL in the comment so the next refresh
   doesn't have to re-derive it.

5. **Leave NULL when there's no defensible reference.** Examples:
   - Versions whose name doesn't map to any upstream release (`qwen3.5`
     without size suffix; sub-family naming the vendor never sold).
   - Free-tier-only Labs SKUs with no commercial rate (e.g.
     `devstral-small-2:24b`).
   - Open weights with no published per-token host (rare; investigate
     before falling back).
   `pricingForOllamaModelKey` returning `null` is correct — it persists
   `usage.unit_price` as NULL, which aggregates to zero cost. Better than
   a guess.

6. **Backfill historical rows** with `backfill-model-pricing` when an
   existing model's rate moved. New rows pick the new price automatically.

## Sources to avoid

- **LiteLLM `model_prices_and_context_window.json`** — `ollama/*` entries
  are hardcoded to `0.0` by design. Reading from there silently zeros every
  row.
- **HTML scraping the per-model tier label** (`Light` / `Medium` / `High` /
  `Extra High` on `https://ollama.com/library/<m>`) — it's the subscription
  GPU-time weight, not a token price, and conflating them silently
  mis-bills.

## Cautions

- Don't fabricate a price by extrapolating from an adjacent version (e.g.
  estimating `glm-4.7` from `glm-4.6`). Leave NULL.
- Don't map by name string when the version reads ambiguous. `qwen3.5` on
  Ollama and `qwen3-235b-a22b-instruct-2507` on DashScope are not necessarily
  the same release; confirm with a release-note pair before linking them.
- Cross-provider spread is large; the choice of anchor changes user-visible
  cost several-fold. Pick deliberately, and write the choice into the
  comment so the next refresh doesn't have to re-derive it.
- Pricing is USD per million tokens, single REAL per `BillingDimension`.
  Falls back per `unitPriceForDimension` (cached → uncached, image → text).
  Don't pre-bake the fallback into the table.
