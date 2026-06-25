import type { ModelAliasRules } from './types.ts';
import { formatAliasRuleBadges } from '@floway-dev/protocols/common';

// Render the closed rule set as a parenthesized suffix the gateway appends to
// the target model's display name when the operator did not supply an
// explicit alias `displayName`. The per-rule labels come from the protocol's
// shared `formatAliasRuleBadges` so the dashboard's per-badge view and this
// inline suffix always agree on wording and order.
export const formatAliasRulesSummary = (rules: ModelAliasRules): string => {
  const parts = formatAliasRuleBadges(rules);
  return parts.length > 0 ? ` (${parts.join(', ')})` : '';
};

// Compose the alias-local display name — what the operator named the alias
// (when set) or a synthesized target + rules summary. Independent of which
// upstream is surfacing the alias; the prefixed listing form prepends the
// upstream display name at the call site, mirroring the real-model path in
// `registry.ts`.
export const composeAliasDisplayName = (input: {
  aliasDisplayName?: string;
  targetDisplayName: string;
  rules: ModelAliasRules;
}): string => {
  if (input.aliasDisplayName !== undefined) return input.aliasDisplayName;
  return `${input.targetDisplayName}${formatAliasRulesSummary(input.rules)}`;
};
