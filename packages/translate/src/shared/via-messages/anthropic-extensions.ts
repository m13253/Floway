import type { MessagesPayload, MessagesThinkingDisplay } from '@floway-dev/protocols/messages';

// Build a Messages `thinking` block from the Floway extension fields a
// non-Messages inbound carries (`thinking_budget`, `adaptive_thinking`,
// `reasoning_summary`). `adaptive_thinking: true` overrides `thinking_budget`
// because the alias write-side validator enforces single-facet selection;
// when both still arrive the adaptive choice wins.
//
// The summary mapping collapses the OpenAI-style {auto|concise|detailed|
// omitted} vocabulary onto Anthropic's structured `thinking.display`
// enumeration: concise + detailed both surface a redacted summary, so they
// collapse to `summarized`; `omitted` is the canonical hide-everything
// spelling; `auto` returns undefined so Anthropic's account default takes
// over. Operator-typed values that match neither vocabulary pass through
// verbatim — Anthropic rejects unknown values at the wire, which is the
// explicit-failure path.
//
// `reasoningSummary` synthesizes `thinking.{type:'enabled', display}` when
// the inbound carries summary but no budget/adaptive signal — without an
// explicit thinking mode Anthropic would otherwise discard the display
// field.
export const buildMessagesThinkingFromExtensions = (input: {
  thinkingBudget?: number;
  adaptiveThinking?: boolean;
  reasoningSummary?: string;
}): MessagesPayload['thinking'] | undefined => {
  const display = input.reasoningSummary !== undefined ? mapSummary(input.reasoningSummary) : undefined;
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

const mapSummary = (summary: string): MessagesThinkingDisplay | string | undefined => {
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
