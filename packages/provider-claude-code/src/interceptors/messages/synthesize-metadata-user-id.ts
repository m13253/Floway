import type { ClaudeCodeMessagesBoundaryCtx } from './types.ts';

// Real CC includes `metadata.user_id` on every /v1/messages request: a JSON
// envelope `{device_id, account_uuid, session_id}` (v2.1.78+) or the legacy
// underscore-delimited string (pre-2.1.78). Anthropic's detector treats a
// missing user_id as one of several CC-shape failures, and even a third-
// party id seeds the same plan-billing routing key the CLI uses — so we
// always populate it on the re-mimicry path.
//
// The shape we emit is the new JSON form, matching CC v2.1.78+ verbatim:
//   {"device_id":"<32-hex>","account_uuid":"","session_id":"<uuidv4>"}
//
// Deterministic ids: device_id is per-upstream stable (one CC "device" per
// upstream record), session_id is per-payload (so a multi-turn conversation
// re-uses the same session_id when the same prefix repeats, the same
// property prompt-cache routing wants). Stability comes from sha256 over
// (upstream id + nonce / payload prefix); randomness would defeat the
// upstream's cache and burn rate-limit slots faster.
//
// account_uuid is the empty string by convention — real CC uses the empty
// string for personal accounts and a real UUID for org members; sub2api
// observed the upstream accepts an empty string regardless. We always emit
// empty rather than chasing the operator's actual org UUID, which we have
// in ctx.config but does not need to leak into per-request mimicry.
//
// References:
//   - https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_handler.go

export const synthesizeMetadataUserId = async <TResult>(
  ctx: ClaudeCodeMessagesBoundaryCtx,
  _request: object,
  run: () => Promise<TResult>,
): Promise<TResult> => {
  const existing = ctx.payload.metadata?.user_id;
  if (typeof existing === 'string' && existing.length > 0) return await run();

  const deviceId = await deviceIdForUpstream(ctx.upstreamId);
  const sessionId = await sessionIdForPayload(ctx.upstreamId, ctx.payload);
  const userId = JSON.stringify({ device_id: deviceId, account_uuid: '', session_id: sessionId });

  ctx.payload = { ...ctx.payload, metadata: { ...(ctx.payload.metadata ?? {}), user_id: userId } };
  return await run();
};

// 32 hex chars matches the format real CC emits (collected from packet
// captures cross-referenced with sub2api fixtures).
const deviceIdForUpstream = async (upstreamId: string): Promise<string> => {
  const hex = await sha256Hex(`claude-code-device:${upstreamId}`);
  return hex.slice(0, 32);
};

// Session id derives from the upstream id plus the first user message text,
// so multi-turn conversations of the same conversation prefix re-use the
// same session id (good for prompt cache) but different conversations get
// different ids. Matches the strategy injectSessionId uses on the Codex
// side, with a per-upstream salt so two upstreams running the same script
// don't collide.
const sessionIdForPayload = async (upstreamId: string, payload: { messages?: unknown }): Promise<string> => {
  const firstUser = firstUserMessageText(payload.messages);
  return await sha256Uuidv4(`claude-code-session:${upstreamId}${firstUser}`);
};

const firstUserMessageText = (messages: unknown): string => {
  if (!Array.isArray(messages)) return '';
  for (const msg of messages) {
    if (typeof msg !== 'object' || msg === null) {
      throw new TypeError(`Claude Code synthesize-metadata-user-id: message must be an object, got ${msg === null ? 'null' : typeof msg}`);
    }
    const m = msg as { role?: unknown; content?: unknown };
    if (m.role !== 'user') continue;
    if (typeof m.content === 'string') return m.content;
    if (!Array.isArray(m.content)) {
      throw new TypeError(`Claude Code synthesize-metadata-user-id: first user-message content must be a string or array, got ${typeof m.content}`);
    }
    return m.content
      .map(part => {
        if (typeof part !== 'object' || part === null) {
          throw new TypeError(`Claude Code synthesize-metadata-user-id: content part must be an object, got ${part === null ? 'null' : typeof part}`);
        }
        const p = part as { type?: unknown; text?: unknown };
        if (p.type !== 'text') return '';
        if (typeof p.text !== 'string') {
          throw new TypeError(`Claude Code synthesize-metadata-user-id: text content part must carry a string .text, got ${typeof p.text}`);
        }
        return p.text;
      })
      .filter(Boolean)
      .join('\n');
  }
  return '';
};

const sha256Hex = async (input: string): Promise<string> => {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(input));
  return Array.from(new Uint8Array(buf), b => b.toString(16).padStart(2, '0')).join('');
};

// Same UUIDv4 stamping trick injectSessionId uses on the Codex side: stamp
// the sha256 hex with the version-4 nibble inline and overwrite the variant
// nibble so the output validates as a real UUIDv4.
const sha256Uuidv4 = async (input: string): Promise<string> => {
  const hex = await sha256Hex(input);
  const variantNibble = ((parseInt(hex[16], 16) & 0x3) | 0x8).toString(16);
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-${variantNibble}${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
