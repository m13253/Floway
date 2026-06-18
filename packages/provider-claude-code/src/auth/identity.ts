import { CLAUDE_CODE_PROFILE_URL } from '../constants.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

// Identity derived from `GET /api/oauth/profile` plus the optional CLI
// `subscriptionType` field. The Anthropic upstream returns nested
// `account.uuid` / `organization.uuid`; we flatten at the boundary so the
// rest of the package never re-handles the wire shape.
export interface ClaudeCodeIdentity {
  email: string;
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string;
}

// Cross-checked third-party gateways:
// https://github.com/Wei-Shaw/claude-relay-service/blob/7dc21cf2820a6784831f289442a38d58fe827f34/src/services/account/claudeAccountService.js#L2241
// https://github.com/ghboke/claude-code-reverse/blob/570324dac73ef43bdcd36660188f3cb66524e572/THIRD_PARTY_CLIENT_GUIDE.md
//
// The wire shape is:
// { account: { uuid, email, has_claude_max, has_claude_pro, ... },
//   organization: { uuid, organization_type: 'claude_max'|'claude_pro'|...,
//                   rate_limit_tier: 'default_claude_max_20x'|'default_claude_max_5x'|... } }
//
// `subscriptionType` is the canonical CLI representation: `pro`, `max_5x`,
// `max_20x`, `enterprise`, `team`. We derive it from the profile by combining
// `organization_type` with `rate_limit_tier`. This matches the value the
// CLI persists in `~/.claude/.credentials.json`'s `subscriptionType` field,
// so both ingestion paths produce a consistent string. When we ingest
// credentials.json directly (path with optional override), the caller may
// pass through that field verbatim instead of re-deriving.
export const fetchClaudeCodeIdentity = async (
  accessToken: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeIdentity> => {
  const response = await fetcher(CLAUDE_CODE_PROFILE_URL, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${accessToken}`,
      accept: 'application/json',
    },
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : null;
  } catch (cause) {
    throw new Error(`Claude Code /api/oauth/profile returned non-JSON body (${response.status})`, { cause: cause as Error });
  }

  if (!response.ok) {
    const message = readErrorMessage(parsed) ?? rawText.slice(0, 256);
    throw new Error(`Claude Code /api/oauth/profile returned ${response.status}: ${message}`);
  }

  if (typeof parsed !== 'object' || parsed === null) {
    throw new Error('Claude Code /api/oauth/profile response is not an object');
  }
  const root = parsed as Record<string, unknown>;
  const account = root.account;
  if (typeof account !== 'object' || account === null) {
    throw new Error('Claude Code /api/oauth/profile response missing `account`');
  }
  const accountObj = account as Record<string, unknown>;
  const accountUuid = accountObj.uuid;
  const email = accountObj.email;
  if (typeof accountUuid !== 'string' || accountUuid === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.uuid`');
  }
  if (typeof email !== 'string' || email === '') {
    throw new Error('Claude Code /api/oauth/profile response missing `account.email`');
  }

  // `organization` is absent for personal accounts; only when present do we
  // capture its uuid + tier. The on-disk schema permits `organizationUuid:
  // null` exactly to model this.
  let organizationUuid: string | null = null;
  let organizationType: string | null = null;
  let rateLimitTier: string | null = null;
  const organization = root.organization;
  if (typeof organization === 'object' && organization !== null) {
    const orgObj = organization as Record<string, unknown>;
    if (typeof orgObj.uuid === 'string' && orgObj.uuid !== '') {
      organizationUuid = orgObj.uuid;
    }
    if (typeof orgObj.organization_type === 'string' && orgObj.organization_type !== '') {
      organizationType = orgObj.organization_type;
    }
    if (typeof orgObj.rate_limit_tier === 'string' && orgObj.rate_limit_tier !== '') {
      rateLimitTier = orgObj.rate_limit_tier;
    }
  }

  return {
    email,
    accountUuid,
    organizationUuid,
    subscriptionType: deriveSubscriptionType(organizationType, rateLimitTier),
  };
};

// Maps the (organization_type, rate_limit_tier) pair to the same string the
// CLI persists in credentials.json. `claude_max` requires the rate-limit tier
// to disambiguate 5x vs 20x; the other recognized tiers are 1:1. An absent
// organization block, an unknown organization_type, or a claude_max without a
// recognized rate_limit_tier is thrown rather than silently coerced — future
// Anthropic shape changes (new tiers, new types) should fail loud at ingest
// time so the operator notices, instead of silently mislabeling accounts.
const deriveSubscriptionType = (
  organizationType: string | null,
  rateLimitTier: string | null,
): string => {
  if (organizationType === null) {
    throw new Error('Claude Code /api/oauth/profile response is missing `organization.organization_type`');
  }
  if (organizationType === 'claude_max') {
    if (rateLimitTier === 'default_claude_max_20x') return 'max_20x';
    if (rateLimitTier === 'default_claude_max_5x') return 'max_5x';
    throw new Error(`Claude Code /api/oauth/profile carries organization_type='claude_max' with unknown rate_limit_tier='${String(rateLimitTier)}'`);
  }
  if (organizationType === 'claude_pro') return 'pro';
  if (organizationType === 'claude_enterprise') return 'enterprise';
  if (organizationType === 'claude_team') return 'team';
  throw new Error(`Claude Code /api/oauth/profile carries unknown organization_type='${organizationType}'`);
};

const readErrorMessage = (parsed: unknown): string | null => {
  if (typeof parsed !== 'object' || parsed === null) return null;
  const root = parsed as Record<string, unknown>;
  if (typeof root.error === 'string') return root.error;
  if (typeof root.error === 'object' && root.error !== null) {
    const err = root.error as Record<string, unknown>;
    if (typeof err.message === 'string') return err.message;
  }
  if (typeof root.message === 'string') return root.message;
  return null;
};
