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
