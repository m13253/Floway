// `subscriptionType` arrives from the provider in its CLI-canonical form
// (`pro`, `max_5x`, `max_20x`, `enterprise`, `team`) — see
// packages/provider-claude-code/src/auth/identity.ts. The CLI-canonical
// form is the source of truth at the storage and protocol level, but
// reads poorly in the dashboard; map known values to Anthropic's
// marketing-style label and pass unknown values through verbatim so a
// future tier still surfaces while a derivation gap is being plumbed.
const FRIENDLY_LABEL: Record<string, string> = {
  pro: 'Pro',
  max_5x: 'Max 5×',
  max_20x: 'Max 20×',
  team: 'Team',
  enterprise: 'Enterprise',
};

export const formatClaudeCodeSubscriptionType = (raw: string | null | undefined): string | null => {
  if (!raw) return null;
  return FRIENDLY_LABEL[raw] ?? raw;
};
