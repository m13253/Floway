import type { ModelAliasRules } from './types.ts';

// Render the closed rule set as a parenthesized suffix the gateway appends to
// the target model's display name when the operator did not supply an
// explicit alias `displayName`. The wording stays compact (`value label`,
// joined with commas) because the suffix has to fit alongside the target
// name in narrow listings — the dashboard's per-badge view uses
// `formatAliasRuleBadges` for the self-describing `label: value` form.
//
// `anthropicBeta` is sorted at format time so two operators carrying the same
// token set in different orders see the same label.
export const formatAliasRulesSummary = (rules: ModelAliasRules): string => {
  const parts: string[] = [];
  if (rules.reasoning?.effort !== undefined) parts.push(`${rules.reasoning.effort} effort`);
  if (rules.reasoning?.budgetTokens !== undefined) parts.push(`${rules.reasoning.budgetTokens}tk reasoning`);
  if (rules.reasoning?.adaptive === true) parts.push('adaptive reasoning');
  if (rules.reasoning?.summary !== undefined) parts.push(`${rules.reasoning.summary} summary`);
  if (rules.verbosity !== undefined) parts.push(`${rules.verbosity} verbosity`);
  if (rules.serviceTier !== undefined) parts.push(`${rules.serviceTier} tier`);
  if (rules.anthropicSpeed !== undefined) parts.push(`${rules.anthropicSpeed} speed`);
  if (rules.anthropicBeta !== undefined && rules.anthropicBeta.length > 0) {
    parts.push([...rules.anthropicBeta].sort().join('/'));
  }
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
