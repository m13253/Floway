// Static catalog of Claude Code dated models. Anthropic exposes only the
// three dated ids below to subscription clients; there is no `/v1/models`
// equivalent CC clients consult, so we ship the list inline rather than
// fetching it. The catalog stays small on purpose — the operator's
// upstream-model toggles operate on the public ids in this list.
//
// Context window: Anthropic publishes 200k tokens for all current models
// (https://docs.claude.com/en/docs/about-claude/models/overview); we ship
// 1_000_000 for Sonnet to match the `context-1m` beta. Operators who run
// without that beta still get the 200k window enforced upstream-side.

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { UpstreamModel } from '@floway-dev/provider';

const SHARED_FIELDS = {
  owned_by: 'anthropic',
  kind: 'chat' as const,
  endpoints: { messages: {} },
  enabledFlags: new Set<string>(),
};

const datedModel = (
  id: string,
  display_name: string,
  contextWindow: number,
): UpstreamModel => {
  const cost = pricingForClaudeCodeModelKey(id);
  return {
    id,
    display_name,
    ...SHARED_FIELDS,
    limits: { max_context_window_tokens: contextWindow },
    ...(cost ? { cost } : {}),
  };
};

export const CLAUDE_CODE_MODELS: readonly UpstreamModel[] = [
  datedModel('claude-sonnet-4-5-20250929', 'Claude Sonnet 4.5', 1_000_000),
  datedModel('claude-opus-4-5-20251101', 'Claude Opus 4.5', 200_000),
  datedModel('claude-haiku-4-5-20251001', 'Claude Haiku 4.5', 200_000),
];
