import type { CodexUpstreamConfig } from '../config.ts';
import type { CodexUpstreamState } from '../state.ts';
import type { CodexIdTokenIdentity } from './jwt.ts';
import { parseCodexIdTokenClaims } from './jwt.ts';
import { exchangeCodexAuthorizationCode } from './oauth.ts';
import type { Fetcher } from '@floway-dev/provider';

export interface CodexImportResult {
  config: CodexUpstreamConfig;
  state: CodexUpstreamState;
}

const buildCodexImportResult = (params: {
  identity: CodexIdTokenIdentity;
  accessToken: string;
  refreshToken: string;
  expiresAt: number;
  now: string;
}): CodexImportResult => ({
  config: {
    accounts: [{
      email: params.identity.email,
      chatgptAccountId: params.identity.chatgptAccountId,
      chatgptUserId: params.identity.chatgptUserId,
      planType: params.identity.planType,
    }],
  },
  state: {
    accounts: [{
      chatgptAccountId: params.identity.chatgptAccountId,
      refresh_token: params.refreshToken,
      state: 'active',
      state_updated_at: params.now,
      accessToken: {
        token: params.accessToken,
        expiresAt: params.expiresAt,
        refreshedAt: params.now,
      },
      quotaSnapshot: null,
    }],
  },
});

// Imports a verbatim ~/.codex/auth.json. The CLI's on-disk format wraps tokens
// under `.tokens`. We re-derive identity from id_token rather than trusting the
// file's account_id / email / plan, so this path produces the same shape as
// importCodexFromCallback (which only has the OAuth response to work from).
export const importCodexFromAuthJson = async (authJson: unknown): Promise<CodexImportResult> => {
  const pickNonEmptyString = (record: Record<string, unknown>, key: string, prefix: string): string => {
    const value = record[key];
    if (typeof value !== 'string' || value === '') throw new TypeError(`${prefix}.${key} must be a non-empty string`);
    return value;
  };

  if (typeof authJson !== 'object' || authJson === null) throw new TypeError('auth.json must be a JSON object');
  const obj = authJson as Record<string, unknown>;
  const tokens = obj.tokens;
  if (typeof tokens !== 'object' || tokens === null) throw new TypeError('auth.json.tokens missing');
  const t = tokens as Record<string, unknown>;
  const accessToken = pickNonEmptyString(t, 'access_token', 'auth.json.tokens');
  const refreshToken = pickNonEmptyString(t, 'refresh_token', 'auth.json.tokens');
  const idToken = pickNonEmptyString(t, 'id_token', 'auth.json.tokens');

  const identity = parseCodexIdTokenClaims(idToken);
  // auth.json has no expires_in; conservative 7-day window so the next request
  // refreshes via /oauth/token within the 5-min freshness gate.
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
  return buildCodexImportResult({
    identity,
    accessToken,
    refreshToken,
    expiresAt: Date.now() + sevenDaysMs,
    now: new Date().toISOString(),
  });
};

// Accepts a full URL (`http://localhost:1455/auth/callback?...`) or a bare
// query string (with or without leading `?`). Returns the `code` + `state`
// query params or throws.
export const extractCodexCallbackParams = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  let query: string;
  if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
    try {
      query = new URL(trimmed).search;
    } catch (cause) {
      throw new Error('Callback URL is malformed', { cause: cause as Error });
    }
  } else {
    query = trimmed.startsWith('?') ? trimmed : `?${trimmed}`;
  }
  const params = new URLSearchParams(query);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback URL is missing `code`');
  if (!state) throw new Error('Callback URL is missing `state`');
  return { code, state };
};

// Exchange the authorization code for tokens, then derive identity from the
// returned id_token. The PKCE verifier was stored at PKCE-start time and is
// supplied here. The token exchange is the only network hop on this path
// (identity parses locally from the id_token), so `fetcher` is where the
// caller picks egress for the whole import.
export const importCodexFromCallback = async (opts: { code: string; codeVerifier: string; fetcher: Fetcher }): Promise<CodexImportResult> => {
  const tokens = await exchangeCodexAuthorizationCode({ code: opts.code, codeVerifier: opts.codeVerifier, fetcher: opts.fetcher });
  const identity = parseCodexIdTokenClaims(tokens.id_token);
  return buildCodexImportResult({
    identity,
    accessToken: tokens.access_token,
    refreshToken: tokens.refresh_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    now: new Date().toISOString(),
  });
};
