// `subscriptionType` + `rateLimitTier` arrive from the provider as separate
// fields matching the official CLI's persistence shape in
// ~/.claude/.credentials.json. The CLI keeps them split because the plan
// name ('max') and the usage-multiplier tier ('default_claude_max_5x') are
// independent concepts. The dashboard combines them for display: "Max"
// alone for an unknown rate-limit tier, "Max 5×" / "Max 20×" for the known
// Anthropic Max tiers.

const PLAN_LABEL: Record<'pro' | 'max' | 'team' | 'enterprise', string> = {
  pro: 'Pro',
  max: 'Max',
  team: 'Team',
  enterprise: 'Enterprise',
};

const MAX_RATE_LIMIT_SUFFIX: Record<string, string> = {
  default_claude_max_5x: '5×',
  default_claude_max_20x: '20×',
};

export const formatClaudeCodeSubscriptionType = (
  subscriptionType: 'pro' | 'max' | 'team' | 'enterprise' | null | undefined,
  rateLimitTier: string | null | undefined,
): string | null => {
  if (!subscriptionType) return null;
  const base = PLAN_LABEL[subscriptionType];
  if (subscriptionType !== 'max') return base;
  const suffix = rateLimitTier ? MAX_RATE_LIMIT_SUFFIX[rateLimitTier] : undefined;
  return suffix ? `${base} ${suffix}` : base;
};
