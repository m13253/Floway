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

// Refresh window: a cached token within this much of expiry counts as
// already-expired so the next call mints a fresh one rather than racing the
// upstream clock. Matches codex's pre-call freshness gate.
const REFRESH_SKEW_MS = 5 * 60 * 1000;

const isAccessTokenFresh = (entry: ClaudeCodeAccessTokenEntry): boolean =>
  entry.expiresAt > Date.now() + REFRESH_SKEW_MS;

// v1 carries exactly one account; the asserter rejects anything else. This
// helper exists so the access-token-cache stays pool-agnostic — when the
// schema later grows to N accounts, the call site picks the account first
// and these helpers operate on the chosen index.
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

// Reads, refreshes, and persists. CAS semantics:
//
// - Refresh-token rotation MUST land. The upstream rotates on every refresh
//   call, so a CAS loss here means a sibling rotation already won and our
//   in-flight refresh response holds a token the world has already replaced;
//   carrying on would burn the next refresh as `invalid_grant`. We propagate
//   the error and let the next request re-read state.
// - Cached access-token persistence is best-effort. If a sibling already
//   wrote a fresher entry, the loser's value is fine to drop — both calls
//   minted from a still-rotated refresh chain and the winner's token is
//   newer. We surface persistence storage failures, but a `updated: false`
//   from the repo (an honest CAS miss) is silent.
export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<ClaudeCodeAccessTokenEntry> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} not found`);
  const state = readClaudeCodeUpstreamState(fresh.state);

  // v1 is single-account. Future N-account fan-out picks an index here; for
  // now the invariant is enforced by the asserter.
  const accountIndex = 0;
  const account = state.accounts[accountIndex];
  if (account.state !== 'active') {
    throw new ClaudeCodeOAuthSessionTerminatedError(
      account.stateMessage ?? `account is in state '${account.state}'`,
    );
  }
  if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return account.accessToken;
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
  // fresh access-token cache in a single state transition.
  const rotated = replaceAccountAt(state, accountIndex, account => ({
    ...account,
    refreshToken: refreshed.refresh_token,
    accessToken: newAccessTokenEntry,
    // Keep `state`/`stateUpdatedAt` untouched on a successful refresh —
    // 'active' is already the value we want and bumping the timestamp on
    // every refresh would muddy the dashboard's "credential health changed"
    // signal.
  }));
  const result = await args.repo.saveState(args.upstreamId, rotated, { expectedState: fresh.state });
  if (!result.updated) {
    // CAS loss: a sibling rotation persisted a newer refresh token while
    // we were minting from the prior one. Our fresh response now holds a
    // token that's no longer the live tail of the rotation chain — surface
    // it so the caller retries against the just-persisted state.
    throw new Error(
      `Claude Code refresh-token rotation lost CAS for upstream ${args.upstreamId}; another rotation won`,
    );
  }
  return newAccessTokenEntry;
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
  // Best-effort: if a sibling already flipped or re-imported, the operator
  // gets the more recent state. We swallow CAS loss but propagate storage
  // failures.
  await repo.saveState(upstreamId, flipped, { expectedState }).catch(error => {
    console.warn(`persistTerminalState: failed to record terminal state on ${upstreamId}: ${(error as Error).message}`);
  });
};

// Used in 401-retry: clear the cached access token without touching the
// refresh token, so the next call mints a fresh one.
export const invalidateClaudeCodeAccessToken = async (args: {
  upstreamId: string;
  repo: UpstreamsRepoSlim;
}): Promise<void> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) {
    console.warn(`invalidateClaudeCodeAccessToken: upstream ${args.upstreamId} disappeared mid-request`);
    return;
  }
  const state = readClaudeCodeUpstreamState(fresh.state);
  const accountIndex = 0;
  if (state.accounts[accountIndex].accessToken === null) return;
  const cleared = replaceAccountAt(state, accountIndex, account => ({ ...account, accessToken: null }));
  await args.repo.saveState(args.upstreamId, cleared, { expectedState: fresh.state });
};
