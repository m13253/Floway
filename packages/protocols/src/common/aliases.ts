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

// Discrete reasoning-effort presets understood across upstreams. `xhigh`
// matches the wire value Anthropic / OpenAI use for the highest tier.
export type ReasoningEffort = 'none' | 'low' | 'medium' | 'high' | 'xhigh';

// Reasoning-summary verbosity hint emitted on the Responses / Chat surface.
export type ReasoningSummary = 'auto' | 'concise' | 'detailed' | 'none';

// Output verbosity hint (OpenAI Responses `verbosity`).
export type Verbosity = 'low' | 'medium' | 'high';

// Per-request service tier the upstream advertises (Anthropic `fast`,
// OpenAI `priority` / `flex` / `scale`, default tier).
export type ServiceTier = 'default' | 'flex' | 'priority' | 'scale' | 'fast';

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
    mandatory?: boolean;
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
