// All Claude Code OAuth + data-plane upstream constants. Pinned to the same
// public OAuth client the official `claude` CLI ships with. Independent
// reimplementations cross-checked:
// https://github.com/Wei-Shaw/claude-relay-service/blob/7dc21cf2820a6784831f289442a38d58fe827f34/src/services/account/claudeAccountService.js
// https://github.com/ghboke/claude-code-reverse/blob/570324dac73ef43bdcd36660188f3cb66524e572/THIRD_PARTY_CLIENT_GUIDE.md
export const CLAUDE_CODE_CLIENT_ID = '9d1c250a-e61b-44d9-88ed-5944d1962f5e';

export const CLAUDE_CODE_AUTHORIZE_URL = 'https://claude.ai/oauth/authorize';
export const CLAUDE_CODE_OAUTH_TOKEN_URL = 'https://platform.claude.com/v1/oauth/token';

// Fixed redirect URI registered against CLAUDE_CODE_CLIENT_ID at Anthropic.
// Cannot be changed without re-registering the OAuth client.
export const CLAUDE_CODE_REDIRECT_URI = 'https://platform.claude.com/oauth/code/callback';

// OAuth scope verbatim from the real CLI. `org:create_api_key` is included
// because real Claude Code requests it during interactive sign-in; keeping
// it makes the issued token indistinguishable from a CLI token at the
// OAuth introspection layer.
export const CLAUDE_CODE_OAUTH_SCOPE =
  'org:create_api_key user:profile user:inference user:sessions:claude_code '
  + 'user:mcp_servers user:file_upload';

// Setup-Token scope: inference only. This is the credential class minted by
// Anthropic's "Create a Long-Lived Token" UI — safer for shared deployments
// because the token cannot mint API keys, hit `/api/oauth/profile`, or touch
// any account surface beyond inference. The trade-off: the token has no
// refresh_token and lasts ~1 year, so when it expires the operator must
// re-import. Cross-checked third-party gateways:
// https://github.com/Wei-Shaw/sub2api/blob/main/backend/internal/pkg/oauth/oauth.go (ScopeInference)
// https://github.com/Wei-Shaw/claude-relay-service/blob/main/src/utils/oauthHelper.js (SCOPES_SETUP)
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
