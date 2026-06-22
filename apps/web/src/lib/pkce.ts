// Client-side PKCE helpers for the codex and claude-code OAuth flows.
//
// The dashboard mints the verifier, challenge and state in the browser via
// Web Crypto, stashes `{verifier, state}` in sessionStorage while the
// operator is away on the provider's consent screen, then validates the
// state echoed back in the callback URL before posting `{code, verifier}`
// to the gateway's import endpoint. The verifier never leaves the browser
// until the matching state comes back, which is the whole point of PKCE.

const base64UrlEncode = (bytes: Uint8Array): string => {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replaceAll('+', '-').replaceAll('/', '_').replaceAll('=', '');
};

export const generatePkce = async (): Promise<{ verifier: string; challenge: string; state: string }> => {
  const verifierBytes = new Uint8Array(32);
  crypto.getRandomValues(verifierBytes);
  const verifier = base64UrlEncode(verifierBytes);
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  const challenge = base64UrlEncode(new Uint8Array(digest));
  const state = crypto.randomUUID().replaceAll('-', '');
  return { verifier, challenge, state };
};

// Matches the Claude Code CLI's own error string for the `<code>#<state>`
// format so an operator hitting the same failure sees the same wording in
// both places.
const CLAUDE_CODE_INVALID_PASTE = 'Invalid code. Please make sure the full code was copied';

export const parseCallbackPaste = (input: string): { code: string; state: string } => {
  const trimmed = input.trim();
  if (!trimmed) throw new Error('Paste the callback URL or code returned by the provider');

  // Claude Code CLI displays the callback as `<code>#<state>` (a literal '#'
  // separator, no query string). Detected by the absence of any URL-query
  // syntax and the presence of exactly one '#'. Both halves must be
  // non-empty — match the CLI's error wording verbatim.
  if (!trimmed.includes('?') && !trimmed.includes('=') && !trimmed.includes('&')) {
    const hashCount = (trimmed.match(/#/g) ?? []).length;
    if (hashCount === 1) {
      const [code, state] = trimmed.split('#');
      if (!code || !state) throw new Error(CLAUDE_CODE_INVALID_PASTE);
      return { code, state };
    }
    if (hashCount > 1) throw new Error(CLAUDE_CODE_INVALID_PASTE);
  }

  // Anything else is treated as a URL or URL fragment. Strip the leading '?'
  // from a bare query string, and prepend a scheme + host to a path-only
  // input so `URL` can parse it. We deliberately let URL parse errors bubble
  // via cause-chain rather than swallowing them — a malformed paste should
  // surface its real reason to the operator.
  const queryString = (() => {
    if (trimmed.startsWith('?')) return trimmed.slice(1);
    if (trimmed.startsWith('http://') || trimmed.startsWith('https://')) {
      try { return new URL(trimmed).search.replace(/^\?/, ''); } catch (e) { throw new Error(`Could not parse callback URL: ${e instanceof Error ? e.message : String(e)}`, { cause: e }); }
    }
    const questionMarkIndex = trimmed.indexOf('?');
    if (questionMarkIndex !== -1) return trimmed.slice(questionMarkIndex + 1);
    // No '?' but the input contains URL-encoded key=value pairs: treat the
    // whole thing as a bare query string.
    if (trimmed.includes('=')) return trimmed;
    // Neither a URL, a query, nor a Claude Code paste.
    throw new Error('Paste must be the redirected URL, its query string, or the code#state shown by the CLI');
  })();

  const params = new URLSearchParams(queryString);
  const code = params.get('code');
  const state = params.get('state');
  if (!code) throw new Error('Callback is missing the `code` parameter');
  if (!state) throw new Error('Callback is missing the `state` parameter');
  return { code, state };
};

// Only one in-flight authorize per provider is supported at a time. Codex
// and claude-code each own one sessionStorage slot; for claude-code, the
// oauth and setup-token flows share the same slot — the random `state`
// echoed back from the consent screen disambiguates flows on its own.
export const pkceStorageKey = (provider: 'codex' | 'claude-code'): string => `floway:pkce:${provider}`;

interface StashedPkce {
  verifier: string;
  state: string;
}

export const stashPkce = (key: string, payload: StashedPkce): void => {
  sessionStorage.setItem(key, JSON.stringify(payload));
};

export const recallPkce = (key: string, returnedState: string): { verifier: string } | null => {
  const raw = sessionStorage.getItem(key);
  if (!raw) return null;
  const parsed = JSON.parse(raw) as StashedPkce;
  if (parsed.state !== returnedState) return null;
  sessionStorage.removeItem(key);
  return { verifier: parsed.verifier };
};

export const clearPkce = (key: string): void => {
  sessionStorage.removeItem(key);
};
