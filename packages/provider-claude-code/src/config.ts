import type { UpstreamRecord } from '@floway-dev/provider';

// One Claude account's operator-managed identity, derived from /v1/oauth/profile
// at import time. Mutating credentials (refreshToken, accessToken, credential
// health) live in ClaudeCodeUpstreamState instead.
export interface ClaudeCodeAccountIdentity {
  // null when the OAuth token lacks `user:profile` scope (the profile
  // endpoint returns 403 and we fall back to a degraded identity). The
  // dashboard shows a placeholder in that case.
  email: string | null;
  accountUuid: string;
  // Anthropic returns null for personal accounts and a UUID for team / org-tier
  // members. Modeled as nullable so the on-disk shape distinguishes "we asked
  // and the upstream said null" from "absent".
  organizationUuid: string | null;
  // Free-form value passed through from the upstream — 'pro', 'max_5x',
  // 'max_20x', 'team', and possibly future tiers. Captured for dashboard
  // display; not enum-cast so a new value from Anthropic doesn't fail import.
  // null for personal accounts (the profile endpoint omits the organization
  // block) and for organization_type values we do not yet recognize, so a new
  // Anthropic tier does not break ingest. Mirrors the official CLI's on-disk
  // shape (subscriptionType in ~/.claude/.credentials.json is nullable;
  // deriver A10 in cli.js returns null on unknown organization_type).
  subscriptionType: string | null;
}

// Account pool. v1 always carries exactly one entry; the wire shape stays
// array-of-accounts so a future fan-out / round-robin pool feature can land
// without a schema migration. The 1-account invariant is enforced by the
// asserter; ordering is operator-controlled and stable.
export interface ClaudeCodeUpstreamConfig {
  accounts: ClaudeCodeAccountIdentity[];
}

export type ClaudeCodeUpstreamRecord = UpstreamRecord & {
  provider: 'claude-code';
  config: ClaudeCodeUpstreamConfig;
};

const ALLOWED_IDENTITY_KEYS_MAP: Record<keyof ClaudeCodeAccountIdentity, true> = {
  email: true,
  accountUuid: true,
  organizationUuid: true,
  subscriptionType: true,
};

const ALLOWED_CONFIG_KEYS_MAP: Record<keyof ClaudeCodeUpstreamConfig, true> = {
  accounts: true,
};

const assertClaudeCodeAccountIdentity = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_IDENTITY_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (obj.email !== null && (typeof obj.email !== 'string' || obj.email === '')) {
    throw new TypeError(`${where}.email must be null or a non-empty string`);
  }
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`);
  }
  if (obj.organizationUuid !== null && (typeof obj.organizationUuid !== 'string' || obj.organizationUuid === '')) {
    throw new TypeError(`${where}.organizationUuid must be null or a non-empty string`);
  }
  if (obj.subscriptionType !== null && (typeof obj.subscriptionType !== 'string' || obj.subscriptionType === '')) {
    throw new TypeError(`${where}.subscriptionType must be null or a non-empty string`);
  }
};

function assertClaudeCodeUpstreamConfig(value: unknown): asserts value is ClaudeCodeUpstreamConfig {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamConfig must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  // config_json round-trips through canonical serialization, so any surviving
  // key is persisted. Reject unknown keys to keep the on-disk shape closed.
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_CONFIG_KEYS_MAP)) {
      throw new TypeError(`ClaudeCodeUpstreamConfig has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ClaudeCodeUpstreamConfig.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`ClaudeCodeUpstreamConfig.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  assertClaudeCodeAccountIdentity(obj.accounts[0], 'ClaudeCodeUpstreamConfig.accounts[0]');
}

export function assertClaudeCodeUpstreamRecord(record: UpstreamRecord): asserts record is ClaudeCodeUpstreamRecord {
  if (record.provider !== 'claude-code') {
    throw new TypeError(`Expected provider 'claude-code', got '${record.provider}'`);
  }
  assertClaudeCodeUpstreamConfig(record.config);
}
