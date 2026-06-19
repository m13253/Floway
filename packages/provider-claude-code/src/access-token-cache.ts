import {
  ClaudeCodeOAuthSessionTerminatedError,
  refreshClaudeCodeAccessToken,
} from './auth/oauth.ts';
import {
  readClaudeCodeUpstreamState,
  type ClaudeCodeAccessTokenEntry,
  type ClaudeCodeUpstreamState,
} from './state.ts';
import type { Fetcher, UpstreamsRepoSlim } from '@floway-dev/provider';

export type { ClaudeCodeAccessTokenEntry };

// Result of `ensureClaudeCodeAccessToken`. `freshlyMinted` is true when this
// call exchanged the refresh token (a real /v1/oauth/token round-trip) and
// false when the cached entry was returned. It means "minted by this call
// site," not "minted recently": if a sibling request rotated the
// refresh-token between our repo read and the cache decision, the cache hit
// branch still reports false even though the cached token is genuinely
// fresh. The 401-retry path uses this to decide whether a 401 means the
// cached token is stale (invalidate + retry) or that the credential itself
// is dead (give up and surface the 401); the false-positive case (a sibling
// just minted) costs at most one harmless invalidate + re-mint.
export interface EnsuredAccessToken {
  entry: ClaudeCodeAccessTokenEntry;
  freshlyMinted: boolean;
}

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches codex's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

const replaceAccountAt = (
  state: ClaudeCodeUpstreamState,
  index: number,
  patch: (account: ClaudeCodeUpstreamState['accounts'][number]) => ClaudeCodeUpstreamState['accounts'][number],
): ClaudeCodeUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, i) => (i === index ? patch(account) : account)),
});

export interface EnsureClaudeCodeAccessTokenArgs {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
  fetcher: Fetcher;
}

// Reads, refreshes, and persists. The rotated refresh token and the new
// cached access token are committed together in a single CAS write. CAS
// loss on that write is fatal: the upstream rotates on every refresh call,
// so a sibling rotation already burned the refresh token we hold, and
// reusing our response would be rejected as `invalid_grant`. We throw so
// the next request re-reads state and refreshes from the live tail of the
// rotation chain.
export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} not found`);
  const state = readClaudeCodeUpstreamState(fresh.state);

  const accountIndex = 0;
  const account = state.accounts[accountIndex];
  if (account.state !== 'active') {
    throw new ClaudeCodeOAuthSessionTerminatedError(account.stateMessage);
  }
  if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return { entry: account.accessToken, freshlyMinted: false };
  }

  let refreshed;
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, args.fetcher);
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      await persistTerminalState(args.repo, args.upstreamId, fresh.state, state, accountIndex, error.upstreamMessage);
    }
    throw error;
  }

  const now = new Date().toISOString();
  const newAccessTokenEntry: ClaudeCodeAccessTokenEntry = {
    token: refreshed.access_token,
    expiresAt: Date.now() + refreshed.expires_in * 1000,
    refreshedAt: now,
  };

  // Refresh-token rotation: CAS-write the new refresh token alongside the
  // fresh access-token cache in a single state transition. `state` /
  // `stateUpdatedAt` stay untouched on a successful refresh — 'active' is
  // already what we want, and bumping the timestamp on every refresh would
  // muddy the dashboard's "credential health changed" signal.
  const rotated = replaceAccountAt(state, accountIndex, account => ({
    ...account,
    refreshToken: refreshed.refresh_token,
    accessToken: newAccessTokenEntry,
  }));
  const result = await args.repo.saveState(args.upstreamId, rotated, { expectedState: fresh.state });
  if (!result.updated) {
    throw new Error(
      `Claude Code refresh-token rotation lost CAS for upstream ${args.upstreamId}; another rotation won`,
    );
  }
  return { entry: newAccessTokenEntry, freshlyMinted: true };
};

const persistTerminalState = async (
  repo: UpstreamsRepoSlim,
  upstreamId: string,
  expectedState: unknown,
  current: ClaudeCodeUpstreamState,
  accountIndex: number,
  message: string,
): Promise<void> => {
  const flipped = replaceAccountAt(current, accountIndex, account => ({
    ...account,
    state: 'refresh_failed',
    stateMessage: message,
    stateUpdatedAt: new Date().toISOString(),
    accessToken: null,
  }));
  await repo.saveState(upstreamId, flipped, { expectedState });
};

// Used in 401-retry: clear the cached access token without touching the
// refresh token, so the next call mints a fresh one.
export const invalidateClaudeCodeAccessToken = async (args: {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
}): Promise<void> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const accountIndex = 0;
  if (state.accounts[accountIndex].accessToken === null) return;
  const cleared = replaceAccountAt(state, accountIndex, account => ({ ...account, accessToken: null }));
  await args.repo.saveState(args.upstreamId, cleared, { expectedState: fresh.state });
};
