// Gateway-managed Claude Code credential state, persisted in
// upstreams.state_json. Writes happen via UpstreamRepo.saveState with
// optimistic concurrency keyed on the prior state JSON.
//
// The shape carries the long-lived refresh token (rotated on every refresh
// call) plus a cached short-lived access token and the most recent
// `anthropic-ratelimit-unified-*` snapshot. The asserter calls into quota.ts
// for the snapshot's inner shape so consumers see the typed `data` field
// without re-casting at every call site.

import { assertClaudeCodeQuotaSnapshot, type ClaudeCodeQuotaSnapshot } from './quota.ts';

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
// `fetchedAt` is unix ms; `data` is the parsed snapshot whose shape is owned
// by quota.ts and validated by the asserter on read.
export interface ClaudeCodeQuotaSnapshotEntry {
  fetchedAt: number;
  data: ClaudeCodeQuotaSnapshot;
}

// One account's autonomous credential state, joined back to its identity in
// ClaudeCodeUpstreamConfig.accounts via `accountUuid`.
export type ClaudeCodeAccountCredential = ClaudeCodeAccountCredentialBase & ClaudeCodeAccountCredentialHealth;

interface ClaudeCodeAccountCredentialBase {
  accountUuid: string;
  // Anthropic rotates the refresh token on every /v1/oauth/token call. Stored
  // in D1 (not KV) so KV eviction never forces operator re-import.
  refreshToken: string;
  // ISO 8601, written on every state transition (initial import, rotation,
  // terminal-state flip). The mutation paths always set it together with
  // `state`, so it's required on the wire.
  stateUpdatedAt: string;
  accessToken: ClaudeCodeAccessTokenEntry | null;
  quotaSnapshot: ClaudeCodeQuotaSnapshotEntry | null;
}

// `active` carries no message; terminal states carry the upstream's terminal
// message so the dashboard can render it and ensureClaudeCodeAccessToken can
// surface it through ClaudeCodeOAuthSessionTerminatedError without inventing
// a fallback string.
type ClaudeCodeAccountCredentialHealth =
  | { state: 'active'; stateMessage?: undefined }
  | { state: 'session_terminated' | 'refresh_failed'; stateMessage: string };

// Account-pool state. The asserter enforces exactly one account, mirroring
// the same invariant on ClaudeCodeUpstreamConfig.
export interface ClaudeCodeUpstreamState {
  accounts: ClaudeCodeAccountCredential[];
}

// Strict shape gate shared by every asserter in this file: rejects unknown
// keys so a stale field on disk surfaces loudly instead of silently shipping
// to the dashboard.
const assertOnlyKeys = (obj: Record<string, unknown>, allowed: readonly string[], where: string): void => {
  const allowedSet = new Set(allowed);
  for (const key of Object.keys(obj)) {
    if (!allowedSet.has(key)) {
      throw new TypeError(`${where} has unexpected key '${key}'`);
    }
  }
};

const ACCESS_TOKEN_KEYS = ['token', 'expiresAt', 'refreshedAt'] as const;
const QUOTA_SNAPSHOT_KEYS = ['fetchedAt', 'data'] as const;
const CREDENTIAL_KEYS = ['accountUuid', 'refreshToken', 'state', 'stateMessage', 'stateUpdatedAt', 'accessToken', 'quotaSnapshot'] as const;
const STATE_KEYS = ['accounts'] as const;

const assertClaudeCodeAccessTokenEntry = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, ACCESS_TOKEN_KEYS, where);
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
  assertOnlyKeys(obj, QUOTA_SNAPSHOT_KEYS, where);
  if (typeof obj.fetchedAt !== 'number' || !Number.isFinite(obj.fetchedAt)) {
    throw new TypeError(`${where}.fetchedAt must be a finite number`);
  }
  assertClaudeCodeQuotaSnapshot(obj.data, `${where}.data`);
};

const assertClaudeCodeAccountCredential = (value: unknown, where: string): void => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError(`${where} must be a plain object`);
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, CREDENTIAL_KEYS, where);
  if (typeof obj.accountUuid !== 'string' || obj.accountUuid === '') {
    throw new TypeError(`${where}.accountUuid must be a non-empty string`);
  }
  if (typeof obj.refreshToken !== 'string' || obj.refreshToken === '') {
    throw new TypeError(`${where}.refreshToken must be a non-empty string`);
  }
  if (obj.state !== 'active' && obj.state !== 'session_terminated' && obj.state !== 'refresh_failed') {
    throw new TypeError(`${where}.state must be one of 'active' | 'session_terminated' | 'refresh_failed', got ${String(obj.state)}`);
  }
  // Terminal states carry the upstream's terminal message; 'active' must not.
  // This split keeps the access-token cache from inventing a fallback string
  // when it surfaces ClaudeCodeOAuthSessionTerminatedError.
  if (obj.state === 'active') {
    if (obj.stateMessage !== undefined) {
      throw new TypeError(`${where}.stateMessage must be absent on active state`);
    }
  } else if (typeof obj.stateMessage !== 'string' || obj.stateMessage === '') {
    throw new TypeError(`${where}.stateMessage must be a non-empty string on terminal state`);
  }
  if (typeof obj.stateUpdatedAt !== 'string' || obj.stateUpdatedAt === '') {
    throw new TypeError(`${where}.stateUpdatedAt must be a non-empty ISO string`);
  }
  if (obj.accessToken !== null) {
    assertClaudeCodeAccessTokenEntry(obj.accessToken, `${where}.accessToken`);
  }
  if (obj.quotaSnapshot !== null) {
    assertClaudeCodeQuotaSnapshotEntry(obj.quotaSnapshot, `${where}.quotaSnapshot`);
  }
};

export function assertClaudeCodeUpstreamState(value: unknown): asserts value is ClaudeCodeUpstreamState {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw new TypeError('ClaudeCodeUpstreamState must be a plain object');
  }
  const obj = value as Record<string, unknown>;
  assertOnlyKeys(obj, STATE_KEYS, 'ClaudeCodeUpstreamState');
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

// Asserts the wire shape and returns the typed view. The asserter rejects
// absent `accessToken` / `quotaSnapshot` keys (they must be explicit `null`
// when not populated), so no further normalization is needed here.
export const readClaudeCodeUpstreamState = (raw: unknown): ClaudeCodeUpstreamState => {
  assertClaudeCodeUpstreamState(raw);
  return raw;
};
