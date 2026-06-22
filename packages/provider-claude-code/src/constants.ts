// All Claude Code OAuth + data-plane upstream constants. Pinned to the same
// public OAuth client the official `claude` CLI ships with. Independent
// cross-references (different authors, not the same person reshipping under
// two names):
// https://github.com/synacktraa/ccauth/blob/master/ccauth/runner.py (Python; full OAuth flow)
// https://github.com/ghboke/claude-code-reverse/blob/main/THIRD_PARTY_CLIENT_GUIDE.md (decompile guide)
// Wei-Shaw maintains both `sub2api` and `claude-relay-service` — those
// repos count as ONE source for cross-reference purposes; cite them when
// useful but never as two independent confirmations.
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// Fixed redirect URI registered against CLAUDE_CODE_CLIENT_ID at Anthropic.
// Cannot be changed without re-registering the OAuth client.
export const CLAUDE_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// OAuth scope set for the operator-driven dashboard import flow. NOT the
// scope set the official CLI requests when you run `claude` locally — the
// CLI bundle (verified via grep of @anthropic-ai/claude-code@1.0.128
// cli.js) requests only three scopes: `org:create_api_key user:profile
// user:inference`. The broader six-scope set we ship is the convention
// for operator-driven dashboard imports, so the issued token can later
// be used for sessions / MCP servers / file uploads on behalf of the
// operator without re-consenting. Independent cross-references:
//   https://github.com/synacktraa/ccauth/blob/master/ccauth/runner.py (SCOPE — exact 6-string match)
//   https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/oauth/oauth.go (ScopeOAuth — "Browser URL")
//   https://github.com/Wei-Shaw/claude-relay-service/blob/main/src/utils/oauthHelper.js (SCOPES)
// The narrower 5-scope subset (dropping `org:create_api_key`) is what
// ghboke/claude-code-reverse uses for token-only API-call style flows
// where the token will never be used to mint API keys — not applicable
// to us because our import path stores a credential whose scope set
// must remain stable across re-imports.
export const CLAUDE_CODE_OAUTH_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code '
  + 'user:mcp_servers user:file_upload';

// Setup-Token scope: inference only. This is the credential class minted by
// Anthropic's "Create a Long-Lived Token" UI — safer for shared deployments
// because the token cannot mint API keys, hit `/api/oauth/profile`, or touch
// any account surface beyond inference. The trade-off: the token has no
// refresh_token and lasts ~1 year, so when it expires the operator must
// re-import. Single-sourced to Wei-Shaw (sub2api's `ScopeInference` and
// claude-relay-service's `SCOPES_SETUP` both ship this value); the
// `user:inference`-alone scope set is also the logical minimum for the
// inference-only credential class so the single-source risk is low.
//   https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/oauth/oauth.go (ScopeInference)
//   https://github.com/Wei-Shaw/claude-relay-service/blob/main/src/utils/oauthHelper.js (SCOPES_SETUP)
export const CLAUDE_CODE_OAUTH_SETUP_TOKEN_SCOPE = 'user:inference';

// 1 year in seconds. Sent in the setup-token `authorization_code` exchange
// body to request a long-lived access token; both sub2api and crs send the
// same literal. Regular OAuth exchanges omit this so the upstream picks the
// default (~1 hour) and we rely on the refresh_token for renewal.
export const CLAUDE_CODE_SETUP_TOKEN_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

// User-Agent on /v1/oauth/token. Real Claude Code's underlying HTTP layer is
// axios; pinning this matches the wire shape independent reimplementations
// observe in production.
export const CLAUDE_CODE_OAUTH_USER_AGENT = 'axios/1.13.6';

// Identity endpoint that derives email + account/organization UUIDs from a
// fresh access token. Hit on every credential ingestion path so config_json
// has a verified identity rather than trusting client-supplied values. Lives
// on api.anthropic.com (not platform.claude.com — the OAuth host) per
// every cross-checked third-party gateway.
export const CLAUDE_CODE_PROFILE_URL = 'https://api.anthropic.com/api/oauth/profile';

// Live quota probe Anthropic exposes for the OAuth bearer. Surfaces the
// same five-hour / seven-day window snapshot the official CLI fetches
// via its `fetchUtilization` helper.
export const CLAUDE_CODE_USAGE_PROBE_URL = 'https://api.anthropic.com/api/oauth/usage';
