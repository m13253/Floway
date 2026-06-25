import type { MessagesThinkingDisplay } from '@floway-dev/protocols/messages';

// Reverse of via-messages/anthropic-extensions.ts mapSummaryToAnthropicDisplay.
// Anthropic's `summarized` collapsed both `concise` and `detailed`; we pick
// `concise` as the canonical reverse since it is Responses' more compact
// summary mode and round-tripping through the gateway should not silently
// inflate verbosity. Unknown operator-typed values pass through verbatim so
// the Responses upstream gets the original spelling and decides for itself
// whether to accept it.
export const mapAnthropicDisplayToSummary = (display: MessagesThinkingDisplay | string): string | undefined => {
  switch (display) {
  case 'summarized':
    return 'concise';
  case 'omitted':
    return 'omitted';
  case 'full':
    return 'detailed';
  default:
    return display;
  }
};
