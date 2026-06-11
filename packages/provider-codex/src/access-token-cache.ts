import { refreshCodexAccessToken } from './auth/oauth.ts';
import { readCodexUpstreamState, type CodexAccessTokenEntry, type CodexUpstreamState } from './state.ts';
import { getProviderRepo, type Fetcher } from '@floway-dev/provider';

export type { CodexAccessTokenEntry };

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches the data-plane's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

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
  if (account.accessToken.expiresAt <= Date.now() + REFRESH_SKEW_MS) return null;
  return account.accessToken;
};

// Best-effort write: a losing CAS or transient storage error must not crash
// the request. The next call re-reads state and refreshes if needed.
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
  try {
    await getProviderRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
  } catch (err) {
    console.warn(`${where}: failed to persist Codex access token for ${upstreamId}/${accountId}:`, err);
  }
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

// Returns the cached token when still fresh; otherwise calls `mint` with the
// active refresh_token to produce a new entry, persists it, and returns it.
// `mint` owns the OAuth round-trip and any rotated-refresh_token persistence —
// this helper deliberately doesn't fold refresh-token rotation in, because the
// caller's CAS hook for refresh_token has to coordinate with terminal-state
// transitions and lives upstream of this function. `mintCodexAccessToken`
// below is the standard implementation of that callback.
export const ensureCodexAccessToken = async (
  upstreamId: string,
  accountId: string,
  mint: (refreshToken: string) => Promise<CodexAccessTokenEntry>,
): Promise<CodexAccessTokenEntry> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) throw new Error(`Codex upstream ${upstreamId} not found`);
  const state = readCodexUpstreamState(fresh.state);
  const account = state.accounts.find(a => a.chatgptAccountId === accountId);
  if (!account) throw new Error(`Codex account ${accountId} not found in upstream ${upstreamId}`);
  if (account.accessToken && account.accessToken.expiresAt > Date.now() + REFRESH_SKEW_MS) {
    return account.accessToken;
  }
  const minted = await mint(account.refresh_token);
  await persistAccessToken(upstreamId, accountId, minted, 'ensureCodexAccessToken');
  return minted;
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
