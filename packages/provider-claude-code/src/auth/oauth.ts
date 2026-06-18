import {
  CLAUDE_CODE_AUTHORIZE_URL,
  CLAUDE_CODE_CLIENT_ID,
  CLAUDE_CODE_OAUTH_SCOPE,
  CLAUDE_CODE_OAUTH_TOKEN_URL,
  CLAUDE_CODE_OAUTH_USER_AGENT,
  CLAUDE_CODE_REDIRECT_URI,
} from '../constants.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

export interface ClaudeOAuthTokenResponse {
  access_token: string;
  token_type: 'Bearer';
  // Lifetime in seconds, relative to the server's clock at issue time.
  expires_in: number;
  refresh_token: string;
  scope: string;
  // Optional convenience fields the upstream sometimes returns alongside
  // the token; we re-derive identity from /api/oauth/profile rather than
  // trusting these, but they are part of the wire shape and surface to
  // tests / debug logs.
  organization?: { uuid: string };
  account?: { uuid: string; email_address: string };
}

// Terminal error: refresh_token is dead, operator must re-import. Distinct
// from generic OAuth 4xx so callers can react to session-termination
// separately from a transient upstream message.
export class ClaudeCodeOAuthSessionTerminatedError extends Error {
  constructor(public readonly upstreamMessage: string) {
    super(`Claude Code OAuth session terminated: ${upstreamMessage}`);
    this.name = 'ClaudeCodeOAuthSessionTerminatedError';
  }
}

// Both the PKCE exchange and the refresh-token mint treat these codes as
// terminal: `app_session_terminated` is the explicit revoke signal,
// `invalid_grant` is what real Claude Code's OAuth returns on a stale code
// or burned refresh token (recoverable only by restarting the PKCE flow).
const CLAUDE_CODE_TERMINAL_OAUTH_CODES: ReadonlySet<string> = new Set([
  'app_session_terminated',
  'invalid_grant',
]);

const claudeCodeTokenRequest = async (
  body: Record<string, string>,
  terminalCodes: ReadonlySet<string>,
  fetcher: Fetcher,
): Promise<ClaudeOAuthTokenResponse> => {
  const response = await fetcher(CLAUDE_CODE_OAUTH_TOKEN_URL, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'user-agent': CLAUDE_CODE_OAUTH_USER_AGENT,
      accept: 'application/json',
    },
    body: JSON.stringify(body),
  });

  const rawText = await response.text();
  let parsed: unknown;
  try {
    parsed = rawText.length > 0 ? JSON.parse(rawText) : {};
  } catch (cause) {
    throw new Error(
      `Claude Code OAuth /token returned ${response.status} with non-JSON body: ${rawText.slice(0, 256)}`,
      { cause },
    );
  }

  const root = (typeof parsed === 'object' && parsed !== null) ? (parsed as Record<string, unknown>) : null;

  if (!response.ok) {
    let code: string | null = null;
    let message: string | null = null;
    if (typeof root?.error === 'string') {
      code = root.error;
    } else if (root && typeof root.error === 'object' && root.error !== null) {
      const err = root.error as Record<string, unknown>;
      if (typeof err.code === 'string') code = err.code;
      if (typeof err.message === 'string') message = err.message;
    }
    // Anthropic's OAuth surfaces a human-readable message in
    // `error_description`; prefer that over the bare `error` code when both
    // are present so the operator sees "Refresh token revoked" rather than
    // "invalid_grant".
    if (message === null && typeof root?.error_description === 'string') message = root.error_description;
    if (message === null && typeof root?.detail === 'string') message = root.detail;
    message ??= code;
    message ??= rawText.slice(0, 256);
    if (code && terminalCodes.has(code)) {
      throw new ClaudeCodeOAuthSessionTerminatedError(message);
    }
    throw new Error(`Claude Code OAuth /token returned ${response.status}: ${message}`);
  }

  if (root === null) throw new Error('Claude Code OAuth /token response is not an object');
  for (const key of ['access_token', 'refresh_token'] as const) {
    if (typeof root[key] !== 'string' || root[key] === '') {
      throw new Error(`Claude Code OAuth /token response missing ${key}`);
    }
  }
  if (typeof root.expires_in !== 'number' || !Number.isFinite(root.expires_in)) {
    throw new Error('Claude Code OAuth /token response missing expires_in');
  }
  return root as unknown as ClaudeOAuthTokenResponse;
};

// PKCE exchange has no upstream context yet — the upstream is minted from
// this response, so direct egress is the only option.
export const exchangeClaudeCodeAuthorizationCode = async (opts: {
  code: string;
  codeVerifier: string;
}): Promise<ClaudeOAuthTokenResponse> => {
  const body = {
    grant_type: 'authorization_code',
    code: opts.code,
    client_id: CLAUDE_CODE_CLIENT_ID,
    redirect_uri: CLAUDE_CODE_REDIRECT_URI,
    code_verifier: opts.codeVerifier,
  };
  return await claudeCodeTokenRequest(body, CLAUDE_CODE_TERMINAL_OAUTH_CODES, directFetcher);
};

// `fetcher` is required because the refresh has an associated upstream
// and must flow through that upstream's proxy-aware fallback chain rather
// than direct egress.
export const refreshClaudeCodeAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
): Promise<ClaudeOAuthTokenResponse> => {
  const body = {
    grant_type: 'refresh_token',
    refresh_token: refreshToken,
    client_id: CLAUDE_CODE_CLIENT_ID,
  };
  return await claudeCodeTokenRequest(body, CLAUDE_CODE_TERMINAL_OAUTH_CODES, fetcher);
};

// The literal `code=true` query param matches what the real Claude Code CLI
// emits during sign-in.
export const buildClaudeCodeAuthorizeUrl = (args: {
  state: string;
  codeChallenge: string;
}): string => {
  const params = new URLSearchParams({
    client_id: CLAUDE_CODE_CLIENT_ID,
    response_type: 'code',
    code: 'true',
    redirect_uri: CLAUDE_CODE_REDIRECT_URI,
    scope: CLAUDE_CODE_OAUTH_SCOPE,
    state: args.state,
    code_challenge: args.codeChallenge,
    code_challenge_method: 'S256',
  });
  return `${CLAUDE_CODE_AUTHORIZE_URL}?${params.toString()}`;
};
