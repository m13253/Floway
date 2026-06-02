// chatgpt_base_url sub-paths codex pokes during a session.
//
// These are not strictly required for a turn to succeed — codex tolerates 404s
// across most of this surface — but several deserve real handlers for
// non-obvious reasons:
//
//   /codex/analytics-events/events — codex POSTs a payload containing
//     `x-codex-turn-metadata` which carries workspace git remote URLs and
//     sandbox policy. Returning 200 here keeps that telemetry inside floway
//     rather than leaking to the real chatgpt.com if a user accidentally
//     unsets `chatgpt_base_url`.
//
//   /wham/agent-identities/jwks — required only when auth_mode is
//     AgentIdentity. We expose an empty key set so the endpoint exists; a
//     deployment that actually issues AgentIdentity JWTs will need to swap
//     this for a real signing-key publication path.
//
//   /wham/apps — codex sends a JSON-RPC `initialize` here as part of its
//     Apps MCP bridge. We do not implement Apps, so 404 is correct and
//     codex degrades gracefully.
//
//   /plugins/*, /ps/plugins/installed — plugin marketplace endpoints.
//     codex always tries these on startup; 404 disables the marketplace UI
//     without breaking the session.

import type { Context } from 'hono';

export const codexWhamAgentIdentitiesJwks = (c: Context) => c.json({ keys: [] });

export const stub200 = (c: Context) => c.body(null, 200);
export const stub404 = (c: Context) => c.json({ error: 'not_found' }, 404);
