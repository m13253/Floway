import { sha256 } from '@noble/hashes/sha2.js';
import { bytesToHex } from '@noble/hashes/utils.js';

import { CLAUDE_CODE_PROFILE_URL } from '../constants.ts';
import { logWarn } from '../log.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

// Identity derived from `GET /api/oauth/profile` plus the optional CLI
// `subscriptionType` field. The Anthropic upstream returns nested
// `account.uuid` / `organization.uuid`; we flatten at the boundary so the
// rest of the package never re-handles the wire shape.
//
// `email` is nullable because Anthropic only exposes it to tokens carrying
// the `user:profile` scope. A token minted with the inference-only scope
// (some Claude Code subscription deployments do this) gets 403 on the
// profile endpoint, and we fall back to a degraded identity rather than
// refusing to import — see fetchClaudeCodeIdentity for the fallback shape.
export interface ClaudeCodeIdentity {
  email: string | null;
  accountUuid: string;
  organizationUuid: string | null;
  subscriptionType: string | null;
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

  // 403 with a `permission_error` body means the token was minted without the
  // `user:profile` scope — the import path must not refuse credential
  // ingestion just because the operator picked an inference-only scope set.
  // Fall back to a degraded identity: a deterministic UUID-shaped account id
  // derived from the access token (so the same token always presents the
  // same account-uuid for dedup), and nulls for the personal fields. The
  // hot-path data plane never reads these nulls — it consumes
  // `state.accounts[0]` which is keyed by accountUuid.
  if (response.status === 403 && isPermissionError(parsed)) {
    const accountUuid = deriveDegradedAccountUuid(accessToken);
    logWarn('claude_code_identity_degraded_fallback', {
      account_uuid: accountUuid,
      reason: 'profile_403_missing_user_profile_scope',
    });
    return { email: null, accountUuid, organizationUuid: null, subscriptionType: null };
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

// Anthropic's `permission_error` shape: `{ "error": { "type":
// "permission_error", ... } }`. We don't strict-match the message because it
// drifts over time, only the type discriminator.
const isPermissionError = (parsed: unknown): boolean => {
  if (typeof parsed !== 'object' || parsed === null) return false;
  const root = parsed as Record<string, unknown>;
  const error = root.error;
  if (typeof error !== 'object' || error === null) return false;
  const err = error as Record<string, unknown>;
  return err.type === 'permission_error';
};

// Format the first 32 hex chars of sha256(accessToken) into the canonical
// 8-4-4-4-12 UUID layout so the degraded id sorts and displays consistently
// with real Anthropic account UUIDs. Not a real UUID v4 — we don't set the
// version/variant nibbles, because this is purely a local dedup key and the
// upstream never sees it.
const deriveDegradedAccountUuid = (accessToken: string): string => {
  const hex = bytesToHex(sha256(new TextEncoder().encode(accessToken))).slice(0, 32);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
};

// Maps the (organization_type, rate_limit_tier) pair to the same string the
// CLI persists in credentials.json. `claude_max` requires the rate-limit tier
// to disambiguate 5x vs 20x; the other recognized tiers are 1:1. Personal
// accounts arrive with no `organization` block (Anthropic's profile endpoint
// omits it) — we return null to mirror the official CLI (cli.js v2.1.10
// deriver A10 returns null on missing/unknown organization_type). Unrecognized
// `organization_type` strings also return null so a new Anthropic tier does
// not break ingest; we log the unknown value for operator visibility. The one
// throw is for `claude_max` with an unrecognized `rate_limit_tier`, which
// signals genuine Anthropic shape drift on a tier we recognize.
const deriveSubscriptionType = (
  organizationType: string | null,
  rateLimitTier: string | null,
): string | null => {
  if (organizationType === null) return null;
  if (organizationType === 'claude_max') {
    if (rateLimitTier === 'default_claude_max_20x') return 'max_20x';
    if (rateLimitTier === 'default_claude_max_5x') return 'max_5x';
    throw new Error(`Claude Code /api/oauth/profile carries organization_type='claude_max' with unknown rate_limit_tier='${String(rateLimitTier)}'`);
  }
  if (organizationType === 'claude_pro') return 'pro';
  if (organizationType === 'claude_enterprise') return 'enterprise';
  if (organizationType === 'claude_team') return 'team';
  logWarn('claude_code_unknown_organization_type', {
    organization_type: organizationType,
    rate_limit_tier: rateLimitTier,
  });
  return null;
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
