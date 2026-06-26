// Wire-level types for model aliases. Lives in @floway-dev/protocols because
// both the gateway control plane and the dashboard SPA need the same DTO
// shape — keeping it here means a single source of truth for snake_case
// field names and the JSON-serializable rule shapes.
//
// An alias is a named virtual model id that resolves at request time to one
// of N target model ids, optionally overlaying protocol-rule overrides
// (reasoning effort, verbosity, service tier, ...) onto the request IR.
// Resolution runs above prefix routing and never re-enters itself, which
// makes recursive aliasing impossible by construction.

// Endpoint family the alias serves. An alias belongs to exactly one kind;
// rules are only allowed when the kind admits them (today that is `chat`).
export type AliasKind = 'chat' | 'embedding' | 'image';

// Target-picking strategy applied to the pool of currently-routable targets:
//
// - `first-available` — pick the first target in declaration order whose
//   target_model_id resolves to an enabled upstream binding.
// - `random` — pick uniformly at random from the same pool.
//
// When the pool is empty both strategies surface the same 404 to the caller.
export type AliasSelection = 'random' | 'first-available';

// Discrete reasoning-effort presets understood across upstreams. Typed as
// `string` because the gateway forwards rule values verbatim and never
// enum-gates them at the wire boundary; the dashboard pins the canonical
// presets ('none' | 'low' | 'medium' | 'high' | 'xhigh') as combobox
// suggestions so operators see the typical choices.
export type ReasoningEffort = string;

// Reasoning-summary verbosity hint emitted on the Responses / Chat surface.
// String for the same forward-verbatim reason as `ReasoningEffort`;
// canonical presets are 'auto' | 'concise' | 'detailed' | 'none'.
export type ReasoningSummary = string;

// Output verbosity hint (OpenAI Responses `verbosity`). String for the same
// forward-verbatim reason as `ReasoningEffort`; canonical presets are
// 'low' | 'medium' | 'high'.
export type Verbosity = string;

// Per-request service tier the upstream advertises. String for the same
// forward-verbatim reason as `ReasoningEffort`; canonical presets are
// 'default' | 'flex' | 'priority' | 'scale' | 'fast'.
export type ServiceTier = string;

// Rule overlay applied to a chat-kind alias target. Every field is optional;
// an absent field leaves the inbound request value untouched. Rule values
// are forwarded verbatim to the upstream — the gateway does not narrow them
// against the target's advertised capability metadata.
export interface ChatAliasRules {
  reasoning?: {
    effort?: ReasoningEffort;
    budget_tokens?: number;
    adaptive?: boolean;
    summary?: ReasoningSummary;
  };
  verbosity?: Verbosity;
  serviceTier?: ServiceTier;
}

// Rule overlay union keyed by `AliasKind`. Embedding and image targets carry
// an empty record today; the schema reserves the slot so per-kind rules can
// grow later without a fresh migration.
export type AliasRules = ChatAliasRules | Record<string, never>;

// One target row inside an alias's `targets` list. Order is meaningful for
// `first-available` selection and preserved (but ignored) for `random`.
export interface AliasTarget {
  target_model_id: string;
  rules: AliasRules;
}

// Wire DTO returned by `/api/aliases`. snake_case to match the rest of the
// control plane; `display_name === null` means "derive at render time".
export interface ModelAlias {
  name: string;
  kind: AliasKind;
  selection: AliasSelection;
  display_name: string | null;
  visible_in_models_list: boolean;
  targets: AliasTarget[];
  sort_order: number;
  created_at: string;
  updated_at: string;
}

// One badge per configured rule field, in the canonical order. `field`
// names the specific rule slot the badge describes so consumers (the
// dashboard's `ModelInfoBar`, alias-of multi-target collapse) can group
// by field without parsing the human-readable label. `value` is reserved
// for callers that want to render a separate value pill alongside the
// label; today every part already self-describes through `label`, so
// `value` stays undefined.
export type AliasRuleBadgeField =
  | 'reasoning.effort'
  | 'reasoning.budget_tokens'
  | 'reasoning.adaptive'
  | 'reasoning.summary'
  | 'verbosity'
  | 'serviceTier';

export interface AliasRuleBadge {
  label: string;
  field: AliasRuleBadgeField;
  value?: string;
}

// Inline-prose parts for an alias's rules, in the canonical field order. The
// same builder backs `formatAliasRulesInline` (joins labels with `, ` for a
// single summary string) and `formatAliasRuleBadges` (emits badge rows).
// Keeping every surface — inline copy, badge sequence, parenthesized
// suffix in the derived display name — on a single ordered walk means an
// operator who configures `effort + verbosity` sees them in the same order
// whether the dashboard renders badges or a comma-joined caption.
const aliasRuleParts = (rules: AliasRules): AliasRuleBadge[] => {
  const chat = rules as ChatAliasRules;
  const parts: AliasRuleBadge[] = [];
  if (chat.reasoning?.effort !== undefined) parts.push({ field: 'reasoning.effort', label: `${chat.reasoning.effort} effort` });
  if (chat.reasoning?.budget_tokens !== undefined) parts.push({ field: 'reasoning.budget_tokens', label: `${chat.reasoning.budget_tokens}tok budget` });
  if (chat.reasoning?.adaptive === true) parts.push({ field: 'reasoning.adaptive', label: 'adaptive' });
  else if (chat.reasoning?.adaptive === false) parts.push({ field: 'reasoning.adaptive', label: 'non-adaptive' });
  if (chat.reasoning?.summary !== undefined) parts.push({ field: 'reasoning.summary', label: `summary: ${chat.reasoning.summary}` });
  if (chat.verbosity !== undefined) parts.push({ field: 'verbosity', label: `${chat.verbosity} verbosity` });
  if (chat.serviceTier !== undefined) parts.push({ field: 'serviceTier', label: `${chat.serviceTier} tier` });
  return parts;
};

export const formatAliasRuleBadges = (rules: AliasRules): AliasRuleBadge[] => aliasRuleParts(rules);

// Comma-joined version of the same ordered parts. Empty string when no
// rule applies — callers should drop the line entirely rather than render
// blank.
export const formatAliasRulesInline = (rules: AliasRules): string =>
  aliasRuleParts(rules).map(p => p.label).join(', ');

// Derived display name for a single-target alias whose operator did not set
// `display_name`. Bare `target_model_id` when no rule is configured; with
// rules, the inline summary is parenthesized. Multi-target aliases skip
// this helper entirely — the listing falls back to the alias's own name
// because no single target represents the alias.
export const composeAliasDisplayName = (targetModelId: string, rules: AliasRules): string => {
  const inline = formatAliasRulesInline(rules);
  return inline === '' ? targetModelId : `${targetModelId} (${inline})`;
};
