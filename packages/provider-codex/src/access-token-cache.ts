import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from './auth/oauth.ts';
import { readCodexUpstreamState, type CodexAccessTokenEntry, type CodexUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

export type { CodexAccessTokenEntry };

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches the data-plane's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: CodexAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

const findAccountIndex = (state: CodexUpstreamState, accountId: string): number =>
  state.accounts.findIndex(a => a.chatgptAccountId === accountId);

const replaceAccountAccessToken = (
  state: CodexUpstreamState,
  index: number,
  entry: CodexAccessTokenEntry | null,
): CodexUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, i) => (i === index ? { ...account, accessToken: entry } : account)),
});

export const getCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
): Promise<CodexAccessTokenEntry | null> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return null;
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account?.accessToken) return null;
  if (!isAccessTokenFresh(account.accessToken)) return null;
  return account.accessToken;
};

// A losing CAS is not an error — saveState reports it via `updated: false`,
// and the next call re-reads state and refreshes if needed. Genuine storage
// failures propagate so the request path surfaces them rather than silently
// running on a stale cached token.
const persistAccessToken = async (
  upstreamId: string,
  accountId: string,
  entry: CodexAccessTokenEntry | null,
  where: string,
): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) {
    console.warn(`${where}: Codex upstream ${upstreamId} disappeared mid-request`);
    return;
  }
  const state = readCodexUpstreamState(fresh.state);
  const idx = findAccountIndex(state, accountId);
  if (idx < 0) {
    console.warn(`${where}: Codex account ${accountId} not found in upstream ${upstreamId}`);
    return;
  }
  // No-op when invalidating an already-null slot — avoids a spurious CAS write
  // when a 401 retry races a concurrent refresh that already cleared the token.
  if (entry === null && state.accounts[idx].accessToken === null) return;
  const next = replaceAccountAccessToken(state, idx, entry);
  await getProviderRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
};

export const putCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  entry: CodexAccessTokenEntry,
): Promise<void> => { await persistAccessToken(upstreamId, accountId, entry, 'putCodexAccessToken'); };

export const invalidateCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
): Promise<void> => { await persistAccessToken(upstreamId, accountId, null, 'invalidateCodexAccessToken'); };

// Reads, mints, and persists. The mint callback is responsible for routing
// the rotated refresh_token through the upstream's CAS hook;
// `mintCodexAccessToken` below is the standard implementation.
//
// Refresh-race recovery: when the mint throws `invalid_grant`, the
// refresh_token may either be genuinely revoked, or a sibling worker may
// have raced us, won the rotation, and left our copy stale. The cache
// distinguishes by re-reading state and comparing — see
// `recoverFromRefreshRace` below. Other terminal codes (defined in
// `REFRESH_TERMINAL_OAUTH_CODES`) signal credential death under any race
// scenario and skip recovery. Mirrors sub2api's `tryRecoverFromRefreshRace`:
// https://github.com/Wei-Shaw/sub2api/blob/49e99e9d519a55cbe6d3bd94b810978dd64ce4b8/backend/internal/service/oauth_refresh_api.go#L175
export const ensureCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  mint: (refreshToken: string) => Promise<CodexAccessTokenEntry>,
  recoveryAllowed = true,
): Promise<CodexAccessTokenEntry> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Codex upstream ${upstreamId} not found`);
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account) throw new Error(`Codex account ${accountId} not found in upstream ${upstreamId}`);
  if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return account.accessToken;
  }

  let minted: CodexAccessTokenEntry;
  try {
    minted = await mint(account.refresh_token);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError && err.code === 'invalid_grant' && recoveryAllowed) {
      const recovered = await recoverFromRefreshRace(upstreamId, accountId, account.refresh_token, mint);
      if (recovered) return recovered;
    }
    throw err;
  }
  await persistAccessToken(upstreamId, accountId, minted, 'ensureCodexAccessToken');
  return minted;
};

// Re-read state for the same accountId slot and decide whether the
// `invalid_grant` we just saw came from a sibling rotation (return their
// freshly-minted access token) or from a genuinely dead refresh_token
// (return null so the caller re-raises). When a sibling rotated but no
// cached access token is stored — e.g. a concurrent `invalidateCodexAccessToken`
// cleared it — we re-enter the refresh flow once with the live RT in hand.
// The depth guard (`recoveryAllowed: false` on the re-entrant call)
// suppresses a second recovery attempt — if `invalid_grant` strikes again
// the refresh token really is dead and we want the terminal flip.
const recoverFromRefreshRace = async (
  upstreamId: string,
  accountId: string,
  usedRefreshToken: string,
  mint: (refreshToken: string) => Promise<CodexAccessTokenEntry>,
): Promise<CodexAccessTokenEntry | null> => {
  const reread = await getProviderRepo().upstreams.getById(upstreamId);
  if (!reread) return null;
  const rereadState = readCodexUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts.find(a => a.chatgptAccountId === accountId);
  if (!rereadAccount) return null;
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refresh_token === usedRefreshToken) return null;
  console.info(
    `Codex refresh-race recovered for upstream ${upstreamId} account ${accountId}: sibling rotated, using their access token`,
  );
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return rereadAccount.accessToken;
  }
  return await ensureCodexAccessToken(upstreamId, accountId, mint, false);
};

// Mints a fresh access token via /oauth/token and routes the rotated
// refresh_token through the caller's CAS hook. Awaiting the rotation
// persistence (rather than fire-and-forget) is deliberate: under concurrent
// rotations each call's new refresh_token must reach the hook before the
// next attempt reads state, otherwise an unhandled rejection can swallow the
// rotated token and the upstream eventually returns app_session_terminated.
// A losing CAS inside the hook is fine — `expectedState` mismatched a
// concurrent operator re-import or sibling rotation, and the already-
// persisted newer state supersedes ours.
export const mintCodexAccessToken = async (
  refreshToken: string,
  fetcher: Fetcher,
  persistRefreshTokenRotation: (newRefreshToken: string) => Promise<void>,
): Promise<CodexAccessTokenEntry> => {
  const tokens = await refreshCodexAccessToken(refreshToken, fetcher);
  await persistRefreshTokenRotation(tokens.refresh_token);
  return {
    token: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    refreshedAt: new Date().toISOString(),
  };
};
