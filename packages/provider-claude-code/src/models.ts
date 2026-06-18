// Anthropic exposes only the three dated ids below to subscription clients;
// there is no `/v1/models` equivalent CC clients consult, so we ship the list
// inline rather than fetching it. The catalog stays small on purpose — the
// operator's upstream-model toggles operate on the public ids in this list.
//
// Context window: Anthropic publishes 200k tokens for all current models
// (https://docs.claude.com/en/docs/about-claude/models/overview); we ship
// 1_000_000 for Sonnet to match the `context-1m` beta. Operators who run
// without that beta still get the 200k window enforced upstream-side.

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { UpstreamModel } from '@floway-dev/provider';

interface ModelTemplate {
  id: string;
  display_name: string;
  contextWindow: number;
}

const TEMPLATES: readonly ModelTemplate[] = [
  { id: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', contextWindow: 1_000_000 },
  { id: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', contextWindow: 200_000 },
  { id: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', contextWindow: 200_000 },
];

const buildModel = (template: ModelTemplate, enabledFlags: ReadonlySet<string>): UpstreamModel => {
  const cost = pricingForClaudeCodeModelKey(template.id);
  return {
    id: template.id,
    display_name: template.display_name,
    owned_by: 'anthropic',
    kind: 'chat',
    endpoints: { messages: {} },
    enabledFlags,
    limits: { max_context_window_tokens: template.contextWindow },
    ...(cost ? { cost } : {}),
  };
};

export const buildClaudeCodeModels = (enabledFlags: ReadonlySet<string>): UpstreamModel[] =>
  TEMPLATES.map(template => buildModel(template, enabledFlags));
