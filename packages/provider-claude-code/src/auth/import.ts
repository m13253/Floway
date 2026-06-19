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
// a bare query (`?code=…&state=…` or `code=…&state=…`), or a host-relative
// URL whose query carries both `code` and `state`.
export const extractClaudeCodeCallbackParams = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  if (trimmed === '') throw new Error('Callback input is empty');

  let params: URLSearchParams;
  if (/^https?:\/\//i.test(trimmed)) {
    let url: URL;
    try {
      url = new URL(trimmed);
    } catch (cause) {
      throw new Error('Callback URL is malformed', { cause });
    }
    params = url.searchParams;
  } else {
    // Slice at the first `?` so a host-relative paste
    // (`platform.claude.com/oauth/code/callback?code=…&state=…`) parses the
    // post-`?` segment as a query instead of feeding the whole string to
    // URLSearchParams (which would treat it as a single malformed key and
    // surface a confusing "missing code" error).
    const queryStart = trimmed.indexOf('?');
    const query = queryStart >= 0 ? trimmed.slice(queryStart + 1) : trimmed;
    params = new URLSearchParams(query);
  }

  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback input is missing `code`');
  if (!state) throw new Error('Callback input is missing `state`');
  return { code, state };
};

// Both calls (OAuth token exchange + /api/oauth/profile) run through the
// caller-supplied `fetcher` (default: direct). The import flow runs before
// the upstream record exists, so the fetcher cannot be resolved from a
// persisted proxy_fallback_list — the control-plane import route builds it
// from the operator's in-flight form override and threads it in here.
export const importClaudeCodeFromCallback = async (opts: {
  code: string;
  pkceVerifier: string;
  fetcher?: Fetcher;
}): Promise<ClaudeCodeImportResult> => {
  const fetcher = opts.fetcher ?? directFetcher;
  const tokens = await exchangeClaudeCodeAuthorizationCode({
    code: opts.code,
    codeVerifier: opts.pkceVerifier,
    fetcher,
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
//
// `fetcher` is forwarded to the identity call so the control-plane import
// route can route through an operator-supplied proxy chain. Default direct.
export const importClaudeCodeFromCredentialsJson = async (
  rawJson: string,
  fetcher: Fetcher = directFetcher,
): Promise<ClaudeCodeImportResult> => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(rawJson);
  } catch (cause) {
    throw new Error('credentials.json is not valid JSON', { cause });
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
  // check by rejecting obviously-too-small values. `1_000_000_000_000` is
  // 2001-09-09T01:46:40Z in milliseconds; any real OAuth expiry will be
  // larger, while a seconds-encoded expiry from the present-day will be ~10^9.
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
