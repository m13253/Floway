import type { ModelAliasRules } from './types.ts';

// Compose the alias-local display name — what the operator named the alias
// (when set) or a synthesized target + rules summary. Independent of which
// upstream is surfacing the alias; the prefixed listing form prepends the
// upstream display name at the call site, mirroring the real-model path in
// `registry.ts`.
//
// The synthesized form's parenthesized rules suffix uses the compact
// `value label` wording so it fits alongside the target name in narrow
// listings — the dashboard's per-badge view uses `formatAliasRuleBadges`
// for the self-describing `label: value` form. `anthropicBeta` tokens are
// sorted so two operators carrying the same set in different orders see
// the same label.
export const composeAliasDisplayName = (input: {
  aliasDisplayName?: string;
  targetDisplayName: string;
  rules: ModelAliasRules;
}): string => {
  if (input.aliasDisplayName !== undefined) return input.aliasDisplayName;
  const parts: string[] = [];
  const { rules } = input;
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
  const suffix = parts.length > 0 ? ` (${parts.join(', ')})` : '';
  return `${input.targetDisplayName}${suffix}`;
};
