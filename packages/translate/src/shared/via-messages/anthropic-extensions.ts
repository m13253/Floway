import type { MessagesPayload, MessagesThinkingDisplay } from '@floway-dev/protocols/messages';

// Anthropic structured `thinking.display` enumerates three modes; the
// inbound IR's `reasoning_summary` extension and the Responses-native
// `reasoning.summary` share an OpenAI-style {auto|concise|detailed|omitted}
// vocabulary. The mapping collapses concise+detailed onto Anthropic's single
// `summarized` mode (both surface a redacted summary, not the full chain),
// `omitted` is the canonical hide-everything spelling, and `auto` returns
// `undefined` so Anthropic's account-default takes over. Operator-typed
// values that match neither vocabulary pass through verbatim — Anthropic
// rejects unknown values at the wire, which is the explicit-failure path we
// want per the alias design's no-enum-gating contract.
export const mapSummaryToAnthropicDisplay = (summary: string): MessagesThinkingDisplay | string | undefined => {
  switch (summary) {
  case 'concise':
  case 'detailed':
    return 'summarized';
  case 'omitted':
    return 'omitted';
  case 'auto':
    return undefined;
  default:
    return summary;
  }
};

// Merge a beta token list onto an existing `anthropic-beta` header value.
// The header is a case-sensitive, comma-separated list per the Anthropic
// docs; dedupe is by exact-match equality so operators can carry parallel
// tokens that differ only by date suffix. Re-joined with `, ` so the wire
// shape matches both Anthropic's own examples and downstream gateways
// (envoyproxy/ai-gateway).
// References:
// - https://platform.claude.com/docs/en/api/beta-headers
// - https://github.com/envoyproxy/ai-gateway
export const mergeAnthropicBetaTokens = (existing: string | null | undefined, additions: readonly string[]): string => {
  const seen = new Set<string>();
  const merged: string[] = [];
  const collect = (token: string): void => {
    const trimmed = token.trim();
    if (!trimmed || seen.has(trimmed)) return;
    seen.add(trimmed);
    merged.push(trimmed);
  };

  if (existing) {
    for (const token of existing.split(',')) collect(token);
  }
  for (const token of additions) collect(token);

  return merged.join(', ');
};

// Materialize the Messages-bound `anthropic_beta` extension list onto an
// outbound request's `anthropic-beta` header. The helper takes a `Headers`
// object so the caller (typically the gateway-side rule-apply pass) doesn't
// have to re-parse and re-set the header itself.
export const applyAnthropicBetaToHeaders = (headers: Headers, additions: readonly string[]): void => {
  if (!additions.length) return;
  const merged = mergeAnthropicBetaTokens(headers.get('anthropic-beta'), additions);
  if (merged) headers.set('anthropic-beta', merged);
};

// Build a Messages `thinking` block from the Floway extension fields a
// non-Messages inbound carries (`thinking_budget`, `adaptive_thinking`,
// `reasoning_summary`). `adaptive_thinking: true` overrides `thinking_budget`
// because the alias write-side validator enforces single-facet selection;
// when both still arrive the adaptive choice wins.
//
// `reasoningSummary` is the OpenAI-style summary vocabulary
// ({auto|concise|detailed|omitted} plus pass-through). It synthesizes
// `thinking.{type:'enabled', display}` when the inbound carries summary
// but no budget/adaptive signal — without an explicit thinking mode
// Anthropic would otherwise discard the display field.
export const buildMessagesThinkingFromExtensions = (input: {
  thinkingBudget?: number;
  adaptiveThinking?: boolean;
  reasoningSummary?: string;
}): MessagesPayload['thinking'] | undefined => {
  const display = input.reasoningSummary !== undefined ? mapSummaryToAnthropicDisplay(input.reasoningSummary) : undefined;
  const displayPart = display !== undefined ? { display: display as MessagesThinkingDisplay } : {};

  if (input.adaptiveThinking === true) {
    return { type: 'adaptive', ...displayPart };
  }
  if (input.thinkingBudget !== undefined) {
    return { type: 'enabled', budget_tokens: input.thinkingBudget, ...displayPart };
  }
  if (input.reasoningSummary !== undefined && display !== undefined) {
    return { type: 'enabled', ...displayPart };
  }
  return undefined;
};
