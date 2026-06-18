import type { ClaudeCodeUpstreamConfig } from '../config.ts';
import type { ClaudeCodeAccountCredential, ClaudeCodeUpstreamState } from '../state.ts';
import { fetchClaudeCodeIdentity, type ClaudeCodeIdentity } from './identity.ts';
import { exchangeClaudeCodeAuthorizationCode } from './oauth.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

export interface ClaudeCodeImportResult {
  config: ClaudeCodeUpstreamConfig;
  state: ClaudeCodeUpstreamState;
}

const buildClaudeCodeImportResult = (params: {
  identity: ClaudeCodeIdentity;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  now: string;
}): ClaudeCodeImportResult => {
  const credential: ClaudeCodeAccountCredential = {
    accountUuid: params.identity.accountUuid,
    refreshToken: params.refreshToken,
    state: 'active',
    stateUpdatedAt: params.now,
    accessToken: {
      token: params.accessToken,
      expiresAt: params.expiresAt,
      refreshedAt: params.now,
    },
    quotaSnapshot: null,
  };
  return {
    config: {
      accounts: [{
        email: params.identity.email,
        accountUuid: params.identity.accountUuid,
        organizationUuid: params.identity.organizationUuid,
        subscriptionType: params.identity.subscriptionType,
      }],
    },
    state: { accounts: [credential] },
  };
};

// Accepts a full callback URL (`https://platform.claude.com/oauth/code/callback?...`),
// a bare query (`?code=…&state=…` or `code=…&state=…`), or any other URL whose
// `searchParams` carry both `code` and `state`. Throws when either is missing.
export const extractClaudeCodeCallbackParams = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Callback input is empty');

  let params: URLSearchParams;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (cause) {
      throw new Error('Callback URL is malformed', { cause: cause as Error });
    }
    params = url.searchParams;
  } else {
    const query = trimmed.startsWith('?') ? trimmed.slice(1) : trimmed;
    params = new URLSearchParams(query);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback input is missing `code`');
  if (!state) throw new Error('Callback input is missing `state`');
  return { code, state };
};

// OAuth callback ingestion. The PKCE verifier was stored at PKCE-start time
// and is supplied here. Identity is derived by calling /api/oauth/profile
// with the freshly minted access token; we never trust the OAuth response's
// embedded `account` / `organization` fields because they may be stale or
// scoped narrowly compared to the dedicated profile endpoint.
export const importClaudeCodeFromCallback = async (opts: {
  code: string;
  pkceVerifier: string;
  fetcher?: Fetcher;
}): Promise<ClaudeCodeImportResult> => {
  const fetcher = opts.fetcher ?? directFetcher;
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
  });
  const identity = await fetchClaudeCodeIdentity(tokens.access_token, fetcher);
  return buildClaudeCodeImportResult({
    identity,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  });
};

// Verbatim ~/.claude/.credentials.json paste. The CLI's on-disk format wraps
// tokens under `.claudeAiOauth`. The JSON does not carry email / account uuid,
// so we still call /api/oauth/profile to derive identity, but we honor the
// JSON's `subscriptionType` verbatim because that is what the CLI itself
// persists. The JSON's `accessToken` is reused for the cached entry so the
// first request in does not need a refresh round-trip — the file is
// effectively a fresh-enough snapshot of the live credential.
export const importClaudeCodeFromCredentialsJson = async (
  rawJson: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeImportResult> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new Error('credentials.json is not valid JSON', { cause: cause as Error });
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    throw new TypeError('credentials.json must be a JSON object');
  }
  const obj = parsed as Record<string, unknown>;
  const wrapper = obj.claudeAiOauth;
  if (typeof wrapper !== 'object' || wrapper === null || Array.isArray(wrapper)) {
    throw new TypeError('credentials.json missing `claudeAiOauth` object');
  }
  const w = wrapper as Record<string, unknown>;

  const accessToken = pickNonEmptyString(w, 'accessToken', 'credentials.json.claudeAiOauth');
  const refreshToken = pickNonEmptyString(w, 'refreshToken', 'credentials.json.claudeAiOauth');
  const expiresAtRaw = w.expiresAt;
  if (typeof expiresAtRaw !== 'number' || !Number.isFinite(expiresAtRaw)) {
    throw new TypeError('credentials.json.claudeAiOauth.expiresAt must be a finite number (unix ms)');
  }
  // The CLI persists `expiresAt` as unix milliseconds. Versions in the wild
  // all match this; if a future build emits seconds, the cache's freshness
  // gate would clip every read to "stale" and force an immediate refresh —
  // that's a recoverable misclassification, but worth catching as a sanity
  // check by rejecting obviously-too-small values.
  if (expiresAtRaw < 1_000_000_000_000) {
    throw new TypeError('credentials.json.claudeAiOauth.expiresAt looks like seconds, expected milliseconds');
  }

  // CLI's persisted subscriptionType is canonical (`pro` / `max_5x` /
  // `max_20x` / `team` / `enterprise`); take it verbatim. When absent we
  // still need the value, so fall back to whatever the profile endpoint
  // derives.
  const persistedSubscriptionType = typeof w.subscriptionType === 'string' && w.subscriptionType !== ''
    ? w.subscriptionType
    : null;

  const identity = await fetchClaudeCodeIdentity(accessToken, fetcher);
  const finalIdentity: ClaudeCodeIdentity = persistedSubscriptionType !== null
    ? { ...identity, subscriptionType: persistedSubscriptionType }
    : identity;

  return buildClaudeCodeImportResult({
    identity: finalIdentity,
    accessToken,
    refreshToken,
    expiresAt: expiresAtRaw,
    now: new Date().toISOString(),
  });
};

const pickNonEmptyString = (record: Record<string, unknown>, key: string, prefix: string): string => {
  const value = record[key];
  if (typeof value !== 'string' || value === '') {
    throw new TypeError(`${prefix}.${key} must be a non-empty string`);
  }
  return value;
};
