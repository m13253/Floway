---
name: refresh-ollama-pricing
description: Use when ollama.com's hosted catalog changes (new model lands, old
  one retires) or when an upstream commodity host changes its rate, to refresh
  packages/provider-ollama/src/pricing.ts. Manual — no script.
---

# Refresh Ollama Pricing

`OLLAMA_MODEL_PRICING` is notional: Ollama itself doesn't price per token, so
each entry mirrors the cheapest credible commodity host for the same open
weights. Catalog churn is weekly, so re-validate periodically.

## Flow

1. **Pull the live catalog.**
   `curl -s https://ollama.com/api/tags | jq -r '.models[].name' | sort`
   Diff against the string keys + regex coverage in
   `packages/provider-ollama/src/pricing.ts`. Note new models, retired models,
   and entries whose family no longer appears upstream.

2. **For each model needing a price, look up sibling-provider rates from
   models.dev.** `curl -s https://models.dev/api.json | jq '.<provider>.models["<sibling-id>"].cost'`
   Map by weights, not by name — Ollama renames freely. Typical anchors:

   | Family | Sibling provider on models.dev |
   |---|---|
   | `gpt-oss:*` | `groq` (`openai/gpt-oss-*`) |
   | `qwen3-coder:*` | `deepinfra` (cheaper than DashScope) |
   | `deepseek-v*` | `deepseek` first-party |
   | `glm-*` | `zai` first-party |
   | `kimi-k2.*` | `moonshotai` international |
   | `minimax-m*` | `minimax` international |
   | `nemotron-3-*` | `deepinfra` |
   | `gemini-*` | `google` (AI Studio) |
   | `gemma*` | open weights — `{input: 0, output: 0}` |

3. **Pick the cheapest credible host**, not first-party — Ollama is reselling
   GPU access, so the commodity floor is the most defensible "what the operator
   would pay in tokens" anchor. Record the source URL in the entry's comment.

4. **Edit `pricing.ts`.** Add/update entries with `input`,
   `input_cache_read` (when the sibling exposes it), `output`. Group exact
   string keys above; use a regex only when the entire family genuinely shares
   a flat rate (see `minimax-m*`, `gemma[34]:`).

5. **Leave NULL when there's no defensible reference.** Models with no sibling
   host (Ollama-exclusive distillations like `rnj-*`), versions whose name
   doesn't map to any upstream release (e.g. a `qwen3.5` family that doesn't
   match a DashScope SKU), or sub-families with no published per-token price.
   `pricingForOllamaModelKey` returning `null` is correct — it persists
   `usage.unit_price` as NULL, which aggregates to zero cost. Better than a
   guess.

6. **Backfill historical rows** with `backfill-model-pricing` when an existing
   model's rate moved. New rows pick the new price automatically.

## Sources to avoid

- **LiteLLM `model_prices_and_context_window.json`** — `ollama/*` entries are
  hardcoded to `0.0` by design. Reading from there silently zeros every row.
- **OpenRouter `/api/v1/models`** — has no `ollama/*` ids; you'd have to keep
  a name-mapping table just to use it, which is what models.dev already does
  with its sibling-provider structure.
- **HTML scraping the per-model tier label** (`Light` / `Medium` / `High` /
  `Extra High` on `https://ollama.com/library/<m>`) — it's the subscription
  GPU-time weight, not a token price, and conflating them silently mis-bills.

## Cautions

- Don't fabricate a price by extrapolating from an adjacent version (e.g.
  estimating `glm-4.7` from `glm-4.6`). Leave NULL.
- Don't map by name string when the version reads ambiguous. `qwen3.5` on
  Ollama and `qwen3-235b-a22b-instruct-2507` on DashScope are not necessarily
  the same release; confirm with a release-note pair before linking them.
- Cross-provider spread is large (gpt-oss-120b ranges 75× on models.dev,
  qwen3-coder-480b 5×). The choice of sibling host changes user-visible cost
  several-fold — pick deliberately, and write the choice into the comment so
  the next refresh doesn't have to re-derive it.
- Pricing is USD per million tokens, single REAL per `BillingDimension`.
  Falls back per `unitPriceForDimension` (cached → uncached, image → text).
  Don't pre-bake the fallback into the table.
