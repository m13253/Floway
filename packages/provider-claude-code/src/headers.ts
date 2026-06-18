// Pinned mimicry header surface for the Anthropic /v1/messages?beta=true call
// on a Claude Code subscription OAuth bearer. Lifted byte-for-byte from real
// Claude Code traffic at v2.1.181 on 2026-06-19; bump together with the
// CLI version whenever we refresh the mimicry constants.
//
// Anthropic's "third-party" detector keys on the full surface (UA, X-App,
// X-Stainless-*, anthropic-beta, anthropic-version,
// anthropic-dangerous-direct-browser-access) plus the body shape; missing any
// one is sufficient to downgrade a Sonnet/Opus call to extra-usage billing.
// 2026-06-19 probes showed the detector effectively paused, but Anthropic
// can re-arm it at any time, so we ship the full surface defensively.
//
// Casing on the wire matches what is written below: lowercase `anthropic-*`,
// `x-app`, `authorization`; mixed-case `User-Agent`, `Accept`, `Content-Type`,
// and the `X-Stainless-*` family. Both Cloudflare Workers and
// @hono/node-server preserve the casing we set on a `Headers` instance.

export const CLAUDE_CLI_VERSION = '2.1.181';

// `@anthropic-ai/sdk` version bundled inside Claude Code v2.1.181; surfaces
// on the wire as `X-Stainless-Package-Version`.
const STAINLESS_PACKAGE_VERSION = '0.94.0';

// Stable subset of `X-Stainless-*` headers shared across both model groups.
// `X-Stainless-OS` keeps its uppercase 'Linux' value intentionally — the
// real CLI emits it that way and a normalised 'linux' would be a wire-level
// drift from canonical CC. OS / Arch / Runtime values verified against the
// macOS arm64 CC binary 2026-06-19; cross-platform CC builds (Windows /
// x86_64) would emit different values, so re-capture on any platform bump.
const STAINLESS_BASE = {
  'X-Stainless-Lang': 'js',
  'X-Stainless-Package-Version': STAINLESS_PACKAGE_VERSION,
  'X-Stainless-OS': 'Linux',
  'X-Stainless-Arch': 'arm64',
  'X-Stainless-Runtime': 'node',
  'X-Stainless-Runtime-Version': 'v24.3.0',
  'X-Stainless-Retry-Count': '0',
  'X-Stainless-Timeout': '600',
} as const;

const BASE_HEADERS = {
  'User-Agent': `claude-cli/${CLAUDE_CLI_VERSION} (external, cli)`,
  'x-app': 'cli',
  'anthropic-dangerous-direct-browser-access': 'true',
  'anthropic-version': '2023-06-01',
  Accept: 'application/json',
  ...STAINLESS_BASE,
} as const;

// `anthropic-beta` flag set carried by Sonnet/Opus Claude Code requests at
// v2.1.181. Order kept stable to match real CLI output; the upstream is
// space-tolerant but order-stable simplifies fixture diffs.
const ANTHROPIC_BETA_SONNET_OPUS = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'interleaved-thinking-2025-05-14',
  'fine-grained-tool-streaming-2025-05-14',
  'prompt-caching-scope-2026-01-05',
  'effort-2025-11-24',
  'context-management-2025-06-27',
  'extended-cache-ttl-2025-04-11',
].join(',');

// Haiku ships a leaner beta set — Anthropic's detector for Haiku is looser
// but we still send the full Haiku surface for consistency and forward
// robustness against detector tightening.
const ANTHROPIC_BETA_HAIKU = [
  'oauth-2025-04-20',
  'claude-code-20250219',
  'fine-grained-tool-streaming-2025-05-14',
].join(',');

export const CLAUDE_CODE_HEADERS_SONNET_OPUS: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_SONNET_OPUS,
};

export const CLAUDE_CODE_HEADERS_HAIKU: Record<string, string> = {
  ...BASE_HEADERS,
  'anthropic-beta': ANTHROPIC_BETA_HAIKU,
};

// Haiku detection mirrors what real CC does: a substring match on 'haiku'
// in the dated model id (e.g. claude-haiku-4-5-20251001).
export const pickClaudeCodeHeaders = (modelId: string): Record<string, string> =>
  modelId.includes('haiku') ? CLAUDE_CODE_HEADERS_HAIKU : CLAUDE_CODE_HEADERS_SONNET_OPUS;
