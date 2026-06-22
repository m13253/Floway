import type { CopilotUpstreamState } from '../api/types.ts';

// Map the per-tier baseUrl GitHub returns from /copilot_internal/v2/token's
// `endpoints.api` to the marketing label the dashboard renders. Null when
// state has never been seeded (freshly imported and not yet usable) or when
// GitHub routes us to a host we don't have a label for yet — the latter is
// fine to surface as "Copilot" without breaking the page.
export type CopilotAccountTypeLabel = 'individual' | 'business' | 'enterprise';

const BASE_URL_TO_LABEL: Record<string, CopilotAccountTypeLabel> = {
  'https://api.individual.githubcopilot.com': 'individual',
  'https://api.business.githubcopilot.com': 'business',
  'https://api.enterprise.githubcopilot.com': 'enterprise',
};

export const copilotAccountTypeLabel = (state: CopilotUpstreamState | null | undefined): CopilotAccountTypeLabel | null => {
  const baseUrl = state?.copilotToken?.baseUrl;
  return baseUrl ? BASE_URL_TO_LABEL[baseUrl] ?? null : null;
};
