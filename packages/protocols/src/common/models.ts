// Disjoint billing dimensions a single request can be charged on. Every count
// keyed by these is non-overlapping: a prompt token is counted under exactly
// one of `input`, `input_cache_read`, `input_cache_write`,
// `input_cache_write_1h`, or `input_image`, never several at once.
//
// Convention borrowed from models.dev and LiteLLM: bare `input`/`output` mean
// the text modality AND act as the fallback rate for any modality without a
// dedicated rate; the `_image` variants are the image modality. There are no
// image cache dimensions on purpose — a live probe of Azure gpt-image-2
// confirmed its usage object never emits cached fields.
//
// `input_cache_write` is the generic cache-write bucket — protocols without
// a TTL distinction land all their writes here, and on Anthropic it covers
// the default (5-minute) TTL bucket. `input_cache_write_1h` is the explicit
// 1-hour bucket Anthropic surfaces under
// `cache_creation.ephemeral_1h_input_tokens` (extended-cache-ttl-2025-04-11).
// They are disjoint subsets of `cache_creation_input_tokens`.
export type BillingDimension = 'input' | 'input_cache_read' | 'input_cache_write' | 'input_cache_write_1h' | 'input_image' | 'output' | 'output_image';

// Iteration form of BillingDimension; the type union is the source of truth.
export const BILLING_DIMENSIONS: readonly BillingDimension[] = ['input', 'input_cache_read', 'input_cache_write', 'input_cache_write_1h', 'input_image', 'output', 'output_image'];

// Per-model pricing in USD per million tokens, aligned with the sst/models.dev
// `Cost` schema (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Keys are billing dimensions: bare `input`/`output` are the text/fallback rate
// and `_image` keys are the image modality. Every key is optional; an absent key
// falls back per `unitPriceForDimension` (modality → bare, cached → uncached).
//
// `tiers` carries per-request service-tier overrides (Anthropic fast mode,
// OpenAI priority/flex). Each tier key is the wire-value the upstream stamps
// on the usage object (`fast`, `priority`, `flex`, ...). Resolve through
// `resolveEffectivePricing(pricing, usage.tier)` before any unit-price lookup.
export interface ModelPricing extends Partial<Record<BillingDimension, number>> {
  tiers?: Record<string, Partial<Record<BillingDimension, number>>>;
}

// Resolve the USD-per-million-tokens unit price for one dimension against a
// pricing snapshot, applying the LiteLLM-style fallback chain: a modality with
// no dedicated rate falls back to the bare text rate, cached input falls back
// to uncached input, and the 1-hour cache write falls back to the 5-minute
// cache write before reaching uncached input. Returns null when even the
// fallback base is absent (or the whole snapshot is null), which aggregation
// treats as cost 0.
export const unitPriceForDimension = (pricing: ModelPricing | null, dimension: BillingDimension): number | null => {
  if (!pricing) return null;
  switch (dimension) {
  case 'input':
    return pricing.input ?? null;
  case 'input_cache_read':
    return pricing.input_cache_read ?? pricing.input ?? null;
  case 'input_cache_write':
    return pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_cache_write_1h':
    return pricing.input_cache_write_1h ?? pricing.input_cache_write ?? pricing.input ?? null;
  case 'input_image':
    return pricing.input_image ?? pricing.input ?? null;
  case 'output':
    return pricing.output ?? null;
  case 'output_image':
    return pricing.output_image ?? pricing.output ?? null;
  }
};

// Fold the per-tier override (if any) into a flat ModelPricing snapshot, so
// every downstream `unitPriceForDimension` call sees one self-contained map.
// Per-dimension shallow merge: overlay keys win, omitted keys inherit the
// base rate (and then flow through `unitPriceForDimension`'s fallback chain).
// Returns a fresh object that never carries `tiers` — recursion would not
// match any real billing surface. An unknown or absent tier returns the base
// snapshot unchanged (sans `tiers`), so old usage rows with no tier carry on
// pricing identically to before.
export const resolveEffectivePricing = (pricing: ModelPricing | null, tier: string | null | undefined): ModelPricing | null => {
  if (!pricing) return null;
  const { tiers, ...base } = pricing;
  const override = tier != null ? tiers?.[tier] : undefined;
  return override ? { ...base, ...override } : base;
};

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured
// outputs) are orthogonal and modeled separately when needed.
//
// Convention borrowed from Together AI's `type` field on /v1/models, which
// chooses a single string enum because each model id in practice maps to
// one endpoint family. Field is named `kind` rather than `type` because
// PublicModel already carries Anthropic's `type: 'model'` discriminator.
//
// Add a value here only when we actually route that endpoint family — do
// not pre-declare for future capabilities.
export type ModelKind = 'chat' | 'embedding' | 'image';

export type Modality = 'text' | 'image';

// Operator-configured chat capability metadata. Lives in protocols because it
// flows verbatim onto PublicModel.chat (the wire DTO) and is also re-exported
// by @floway-dev/provider as UpstreamChatModelConfig for the catalog side; one
// definition serves both surfaces.
export interface ChatModelInfo {
  modalities?: {
    input: readonly Modality[];
    output: readonly Modality[];
  };
  reasoning?: {
    // Discrete effort levels — a closed set of named presets (e.g. low/medium/high).
    effort?: { supported: readonly string[]; default: string };
    // Operator-supplied token budget. Bounds are optional; absent bounds mean
    // "operator can supply a budget, but legal range is unknown".
    budget_tokens?: { min?: number; max?: number };
    // Model-controlled adaptive depth — the model decides how much reasoning to do.
    adaptive?: boolean;
    // Always-on reasoning — the model cannot be instructed to skip it.
    mandatory?: boolean;
  };
}

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
  // Floway protocol extension. Present on synthesized alias entries the
  // gateway appends to the listing. Clients that do not know about the
  // field ignore it; alias-aware clients (dashboard, CLI shims) render the
  // alias's target id and rules from this payload directly.
  aliasedFrom?: PublicModelAliasedFrom;
  chat?: ChatModelInfo;
}

export interface PublicModelAliasedFrom {
  targetModelId: string;
  upstreamIds: readonly string[];
  rules: {
    reasoning?: {
      effort?: string;
      budgetTokens?: number;
      adaptive?: boolean;
      summary?: string;
    };
    verbosity?: string;
    serviceTier?: string;
    anthropicBeta?: readonly string[];
  };
  onConflict: 'alias-only' | 'real-only' | 'both-real-first' | 'both-alias-first';
  // Operator-set display name. Absent (undefined) when the operator left the
  // field blank — alias-aware UIs then synthesize a label from the target's
  // display name and the inline rules summary instead.
  displayName?: string;
}

// One badge per rule field on an alias, in a `${label}` / `${label}: ${value}`
// shape the dashboard renders inline next to the model row. Returned in a
// deterministic order so the badge sequence stays stable across surfaces and
// across JSON key arrivals. Boolean toggles render label-only (no colon);
// every other field renders as `${label}: ${value}`. The inline-prose form
// (`composeAliasDisplayName`'s suffix and `formatAliasRulesInline`) uses its
// own compact wording — the two surfaces deliberately diverge so the inline
// summary stays compact while the badge view stays self-describing.
export interface AliasRuleBadge {
  label: string;
  value?: string;
}

export const formatAliasRuleBadges = (rules: PublicModelAliasedFrom['rules']): AliasRuleBadge[] => {
  const out: AliasRuleBadge[] = [];
  if (rules.reasoning?.effort !== undefined) out.push({ label: 'effort', value: rules.reasoning.effort });
  if (rules.reasoning?.budgetTokens !== undefined) out.push({ label: 'reasoning budget', value: `${rules.reasoning.budgetTokens}tk` });
  if (rules.reasoning?.adaptive === true) out.push({ label: 'adaptive reasoning' });
  if (rules.reasoning?.summary !== undefined) out.push({ label: 'reasoning summary', value: rules.reasoning.summary });
  if (rules.verbosity !== undefined) out.push({ label: 'verbosity', value: rules.verbosity });
  if (rules.serviceTier !== undefined) out.push({ label: 'service tier', value: rules.serviceTier });
  if (rules.anthropicBeta !== undefined && rules.anthropicBeta.length > 0) {
    out.push({ label: 'anthropic beta', value: [...rules.anthropicBeta].sort().join('/') });
  }
  return out;
};

// Inline-prose parts for an alias's rules, in a deterministic order. Each
// entry uses the compact `value label` wording (e.g. `low effort`,
// `4096tk reasoning`) so it fits both alongside the target name in narrow
// listings and on its own as a standalone summary line. The dashboard's
// per-badge view uses `formatAliasRuleBadges` for the self-describing
// `label: value` form. `anthropicBeta` tokens are sorted so two operators
// carrying the same set in different orders see the same label.
const aliasRulesInlineParts = (rules: PublicModelAliasedFrom['rules']): string[] => {
  const parts: string[] = [];
  if (rules.reasoning?.effort !== undefined) parts.push(`${rules.reasoning.effort} effort`);
  if (rules.reasoning?.budgetTokens !== undefined) parts.push(`${rules.reasoning.budgetTokens}tk reasoning`);
  if (rules.reasoning?.adaptive === true) parts.push('adaptive reasoning');
  if (rules.reasoning?.summary !== undefined) parts.push(`${rules.reasoning.summary} summary`);
  if (rules.verbosity !== undefined) parts.push(`${rules.verbosity} verbosity`);
  if (rules.serviceTier !== undefined) parts.push(`${rules.serviceTier} tier`);
  if (rules.anthropicBeta !== undefined && rules.anthropicBeta.length > 0) {
    parts.push([...rules.anthropicBeta].sort().join('/'));
  }
  return parts;
};

// Compose the alias-local display name — what the operator named the alias
// (when set) or a synthesized target + rules summary. Independent of which
// upstream is surfacing the alias; the prefixed listing form prepends the
// upstream display name at the call site, mirroring the real-model path in
// the gateway's provider registry. The parenthesized rules suffix shares
// its parts with `formatAliasRulesInline` so the two surfaces never drift.
export const composeAliasDisplayName = (input: {
  aliasDisplayName?: string;
  targetDisplayName: string;
  rules: PublicModelAliasedFrom['rules'];
}): string => {
  if (input.aliasDisplayName !== undefined) return input.aliasDisplayName;
  const parts = aliasRulesInlineParts(input.rules);
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${input.targetDisplayName}${suffix}`;
};

// Joined rules summary without the parentheses — what the dashboard's alias
// row renders on its third line. Empty string when no rule applies; callers
// should drop the line entirely in that case rather than rendering blank.
export const formatAliasRulesInline = (rules: PublicModelAliasedFrom['rules']): string => {
  return aliasRulesInlineParts(rules).join(', ');
};

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
