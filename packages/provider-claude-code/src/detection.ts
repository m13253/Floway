import type { MessagesPayload } from '@floway-dev/protocols';

// Decide whether an inbound /v1/messages request is already shaped like a
// real Claude Code session and can pass through unmodified, or whether it
// must be re-mimicked into canonical CC shape before reaching Anthropic.
//
// Predicate strength is the benchmark — the implementation mirrors
// sub2api's `backend/internal/service/claude_code_validator.go`:
// https://github.com/Wei-Shaw/sub2api/blob/4a5665da5b2c6b83c4597844ea6e573746c821b1/backend/internal/service/claude_code_validator.go
//
// Weakening this predicate breaks plan billing in either direction:
//   - Dropping the Dice-template fallback false-negatives pre-v2.1.36 CC
//     clients (their requests carry no billing block but DO route to plan
//     billing today, confirmed by direct probing 2026-06-19). We would
//     re-mimic and replace the user's actual session fingerprint with
//     ours — fidelity loss for zero defensive benefit.
//   - Relaxing the strict gate (UA + headers + metadata.user_id) false-
//     positives non-CC traffic, which Anthropic's detector — when active —
//     downgrades to extra-usage billing.
//
// The detector's status changes without notice; the April-2026 finding
// summarised by https://gist.github.com/mrcattusdev keys on system-prompt
// content and was effectively paused on 2026-06-19, but Anthropic can
// re-arm it any time.

const UA_PATTERN = /^claude-cli\/\d+\.\d+\.\d+/i;
const LEGACY_USER_ID_PATTERN = /^user_([a-fA-F0-9]{64})_account_([a-fA-F0-9-]*)_session_([a-fA-F0-9-]{36})$/;

const DICE_THRESHOLD = 0.5;

// Seven canonical identity prefixes real CC sends as the first text block.
// Includes compact / summarisation flows; dropping the last two false-
// negatives genuine CC compact traffic. v2.1.181 swapped "interactive CLI
// tool" for "interactive agent" — both are kept so older and newer CC
// clients both pass detection. Strings are kept verbatim.
const IDENTITY_TEMPLATES = [
  "You are Claude Code, Anthropic's official CLI for Claude.",
  "You are a Claude agent, built on Anthropic's Claude Agent SDK.",
  "You are Claude Code, Anthropic's official CLI for Claude, running within the Claude Agent SDK.",
  'You are a file search specialist for Claude Code, Anthropic\'s official CLI for Claude.',
  'You are a helpful AI assistant tasked with summarizing conversations.',
  'You are an interactive CLI tool that helps users',
  'You are an interactive agent that helps users',
] as const;

export interface ParsedUserId {
  deviceId: string;
  accountUuid: string;
  sessionId: string;
  isNewFormat: boolean;
}

// `metadata.user_id` arrives in one of two shapes:
//   - legacy (CLI < 2.1.78): user_<sha256>_account_<uuid?>_session_<uuid>
//   - new (CLI >= 2.1.78): JSON {"device_id":"…","account_uuid":"…","session_id":"…"}
// Both are valid CC identifiers; either passes detection.
export const parseMetadataUserID = (raw: string): ParsedUserId | null => {
  const s = raw.trim();
  if (!s) return null;
  if (s.startsWith('{')) {
    let parsed: { device_id?: unknown; account_uuid?: unknown; session_id?: unknown };
    try {
      parsed = JSON.parse(s);
    } catch {
      return null;
    }
    if (typeof parsed.device_id !== 'string' || !parsed.device_id) return null;
    if (typeof parsed.session_id !== 'string' || !parsed.session_id) return null;
    // sub2api intentionally accepts legacy-format CC sessions where the
    // account part is empty (personal accounts that never had an
    // organization UUID), so empty string is a legitimate value here, not
    // a missing-field signal. Coerce non-string to '' for the same reason.
    const accountUuid = typeof parsed.account_uuid === 'string' ? parsed.account_uuid : '';
    return {
      deviceId: parsed.device_id,
      accountUuid,
      sessionId: parsed.session_id,
      isNewFormat: true,
    };
  }
  const m = LEGACY_USER_ID_PATTERN.exec(s);
  if (!m) return null;
  return {
    deviceId: m[1]!,
    accountUuid: m[2]!,
    sessionId: m[3]!,
    isNewFormat: false,
  };
};

const normalize = (s: string): string => s.split(/\s+/).filter(Boolean).join(' ');

const bigrams = (s: string): Map<string, number> => {
  const out = new Map<string, number>();
  const runes = [...s.toLowerCase()];
  for (let i = 0; i < runes.length - 1; i++) {
    const g = runes[i]! + runes[i + 1]!;
    out.set(g, (out.get(g) ?? 0) + 1);
  }
  return out;
};

const dice = (a: string, b: string): number => {
  if (a === b) return 1;
  if (a.length < 2 || b.length < 2) return 0;
  const A = bigrams(a);
  const B = bigrams(b);
  let inter = 0;
  let total = 0;
  for (const [g, ca] of A) {
    total += ca;
    const cb = B.get(g);
    if (cb) inter += Math.min(ca, cb);
  }
  for (const cb of B.values()) total += cb;
  return total === 0 ? 0 : (2 * inter) / total;
};

const matchesAnyIdentityTemplate = (text: string): boolean => {
  const normalized = normalize(text);
  for (const tpl of IDENTITY_TEMPLATES) {
    if (dice(normalized, normalize(tpl)) >= DICE_THRESHOLD) return true;
  }
  return false;
};

const looksLikeBillingBlock = (text: string): boolean =>
  text.startsWith('x-anthropic-billing-header') && text.includes('cc_entrypoint=cli');

const extractSystemTexts = (body: MessagesPayload): string[] => {
  const { system } = body;
  if (!system) return [];
  if (typeof system === 'string') return [system];
  return system.map(block => block.text);
};

export interface ClaudeCodeShapedRequestInput {
  headers: Headers;
  pathname: string;
  body: MessagesPayload | null;
  isMaxTokensOneHaikuProbe: boolean;
}

export const isClaudeCodeShapedRequest = (input: ClaudeCodeShapedRequestInput): boolean => {
  const ua = input.headers.get('user-agent');
  if (!ua || !UA_PATTERN.test(ua)) return false;

  // Anything outside `/v1/messages` passes on UA alone — real CC issues
  // /v1/oauth/profile, /v1/models, /v1/organizations, count_tokens etc., none
  // of which carry the system-prompt + metadata.user_id surface the strict
  // gate below inspects.
  if (input.pathname !== '/v1/messages') return true;
  // Real CC's periodic Haiku connectivity probe sends max_tokens=1 with no
  // system; surface it as CC-shaped without further checks.
  if (input.isMaxTokensOneHaikuProbe) return true;

  if (!input.body) return false;

  if (!input.headers.get('x-app')) return false;
  if (!input.headers.get('anthropic-beta')) return false;
  if (!input.headers.get('anthropic-version')) return false;

  if (typeof input.body.model !== 'string' || input.body.model === '') return false;

  const systemTexts = extractSystemTexts(input.body);
  if (systemTexts.length === 0) return false;
  const systemMatches = systemTexts.some(t => looksLikeBillingBlock(t) || matchesAnyIdentityTemplate(t));
  if (!systemMatches) return false;

  const userId = input.body.metadata?.user_id;
  if (typeof userId !== 'string' || !userId) return false;
  if (!parseMetadataUserID(userId)) return false;

  return true;
};
