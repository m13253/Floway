// Gateway-managed Claude Code credential state, persisted in
// upstreams.state_json. Writes happen via UpstreamRepo.saveState with
// optimistic concurrency keyed on the prior state JSON.
//
// The shape carries the long-lived refresh token (rotated on every refresh
// call) plus a cached short-lived access token and the most recent
// `anthropic-ratelimit-unified-*` snapshot. Deeper validation of the snapshot
// `data` payload lives in quota.ts; here we only confirm the wrapper shape so
// nothing structurally junk slips past.

export type ClaudeCodeCredentialHealth = 'active' | 'session_terminated' | 'refresh_failed';

// Short-lived OAuth access token minted by exchanging the stored refreshToken
// against /v1/oauth/token. The refreshToken itself stays on
// ClaudeCodeAccountCredential so a KV/cache wipe never forces operator
// re-import; only the minted token (and its expiry) belong in state alongside
// it.
export interface ClaudeCodeAccessTokenEntry {
  token: string;
  expiresAt: number;       // unix ms
  refreshedAt: string;     // ISO 8601
}

// Most recent quota observation derived from /v1/messages response headers.
// `fetchedAt` is unix ms; `data` is the parsed snapshot, whose internal shape
// is owned and re-checked at every consumer boundary by quota.ts.
export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number;
  data: unknown;
}

// One account's autonomous credential state, joined back to its identity in
// ClaudeCodeUpstreamConfig.accounts via `accountUuid`.
export interface ClaudeCodeAccountCredential {
  accountUuid: string;
  // Anthropic rotates the refresh token on every /v1/oauth/token call. Stored
  // in D1 (not KV) so KV eviction never forces operator re-import.
  refreshToken: string;
  state: ClaudeCodeCredentialHealth;
  stateMessage?: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths always set it together with
  // `state`, so it's required on the wire.
  stateUpdatedAt: string;
  accessToken: ClaudeCodeAccessTokenEntry | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
}

// Account-pool state. v1 always carries exactly one entry; the asserter
// enforces that, mirroring the same invariant on ClaudeCodeUpstreamConfig.
export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredential[];
}

const ALLOWED_CREDENTIAL_KEYS_MAP: Record<keyof ClaudeCodeAccountCredential, true> = {
  accountUuid: true,
  refreshToken: true,
  state: true,
  stateMessage: true,
  stateUpdatedAt: true,
  accessToken: true,
  quotaSnapshot: true,
};

const ALLOWED_STATE_KEYS_MAP: Record<keyof ClaudeCodeUpstreamState, true> = {
  accounts: true,
};

const ALLOWED_ACCESS_TOKEN_KEYS_MAP: Record<keyof ClaudeCodeAccessTokenEntry, true> = {
  token: true,
  expiresAt: true,
  refreshedAt: true,
};

const ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP: Record<keyof ClaudeCodeQuotaSnapshotEntry, true> = {
  fetchedAt: true,
  data: true,
};

const assertClaudeCodeAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_ACCESS_TOKEN_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.token !== 'string' || obj.token === '') {
    throw new TypeError(`${where}.token must be a non-empty string`);
  }
  if (typeof obj.expiresAt !== 'number' || !Number.isFinite(obj.expiresAt)) {
    throw new TypeError(`${where}.expiresAt must be a finite number`);
  }
  if (typeof obj.refreshedAt !== 'string' || obj.refreshedAt === '') {
    throw new TypeError(`${where}.refreshedAt must be a non-empty string`);
  }
};

const assertClaudeCodeQuotaSnapshotEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_QUOTA_SNAPSHOT_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  if (typeof obj.data !== 'object' || obj.data === null || Array.isArray(obj.data)) {
    throw new TypeError(`${where}.data must be a plain object`);
  }
};

const assertClaudeCodeAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_CREDENTIAL_KEYS_MAP)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`);
  }
  if (typeof obj.refreshToken !== 'string' || obj.refreshToken === '') {
    throw new TypeError(`${where}.refreshToken must be a non-empty string`);
  }
  if (obj.state !== 'active' && obj.state !== 'session_terminated' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`);
  }
  if (obj.stateMessage !== undefined && typeof obj.stateMessage !== 'string') {
    throw new TypeError(`${where}.stateMessage must be a string when present`);
  }
  if (typeof obj.stateUpdatedAt !== 'string' || obj.stateUpdatedAt === '') {
    throw new TypeError(`${where}.stateUpdatedAt must be a non-empty ISO string`);
  }
  if (obj.accessToken !== null && obj.accessToken !== undefined) {
    assertClaudeCodeAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.quotaSnapshot !== null && obj.quotaSnapshot !== undefined) {
    assertClaudeCodeQuotaSnapshotEntry(obj.quotaSnapshot, `${where}.quotaSnapshot`);
  }
};

export function assertClaudeCodeUpstreamState(value: unknown): asserts value is ClaudeCodeUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  for (const key of Object.keys(obj)) {
    if (!(key in ALLOWED_STATE_KEYS_MAP)) {
      throw new TypeError(`ClaudeCodeUpstreamState has unexpected key '${key}'`);
    }
  }
  if (!Array.isArray(obj.accounts)) {
    throw new TypeError('ClaudeCodeUpstreamState.accounts must be an array');
  }
  if (obj.accounts.length !== 1) {
    throw new TypeError(`ClaudeCodeUpstreamState.accounts must hold exactly one account (got ${obj.accounts.length})`);
  }
  for (let i = 0; i < obj.accounts.length; i++) {
    assertClaudeCodeAccountCredential(obj.accounts[i], `ClaudeCodeUpstreamState.accounts[${i}]`);
  }
}

// Boundary normalization: a freshly-imported row may carry no `accessToken` /
// `quotaSnapshot` key (the import path only writes the refresh token); the
// typed contract on `ClaudeCodeAccountCredential` promises `null` rather than
// `undefined`. Build a shallow copy of the state with absent → `null` so
// consumers can rely on `=== null` checks. The original `raw` is left
// untouched so callers (e.g. access-token-cache, quota) can still pass it
// straight through as the CAS `expectedState`.
export const readClaudeCodeUpstreamState = (raw: unknown): ClaudeCodeUpstreamState => {
  assertClaudeCodeUpstreamState(raw);
  return {
    ...raw,
    accounts: raw.accounts.map(account => ({
      ...account,
      accessToken: account.accessToken ?? null,
      quotaSnapshot: account.quotaSnapshot ?? null,
    })),
  };
};
