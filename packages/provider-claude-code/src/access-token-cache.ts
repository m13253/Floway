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
//
// Refresh-race recovery: when the upstream returns `invalid_grant`, it
// might mean either (a) the refresh token is genuinely revoked, or (b) a
// sibling worker raced us, won the rotation, and our copy is now stale.
// `recoverFromRefreshRace` distinguishes by re-reading state and comparing
// the refresh token we used against what is now stored. If a sibling
// rotated, we return their freshly-minted access token (`freshlyMinted:
// false` because this call site did not mint it). If the stored value
// hasn't moved, we treat it as a real death and flip to terminal. Mirrors
// sub2api `oauth_refresh_api.go:tryRecoverFromRefreshRace` (lines
// 173-193). All other terminal codes (`app_session_terminated`,
// `invalid_refresh_token`, `invalid_client`, `unauthorized_client`,
// `access_denied`) signal credential death under any race scenario and
// flip to terminal without a recovery attempt.
export const ensureClaudeCodeAccessToken = async (
  args: EnsureClaudeCodeAccessTokenArgs,
): Promise<EnsuredAccessToken> => ensureClaudeCodeAccessTokenInner(args, true);

const ensureClaudeCodeAccessTokenInner = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  recoveryAllowed: boolean,
): Promise<EnsuredAccessToken> => {
  const fresh = await args.repo.getById(args.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${args.upstreamId} not found`);
  const state = readClaudeCodeUpstreamState(fresh.state);

  const accountIndex = 0;
  const account = state.accounts[accountIndex];
  if (account.state !== 'active') {
    // Surface the stored health state as the `code` so a caller distinguishing
    // by code (e.g. metrics) reflects the persisted reason, not a synthetic
    // OAuth code. Never reaches the refresh-race recovery branch — that only
    // fires inside the catch around the live /v1/oauth/token call below.
    throw new ClaudeCodeOAuthSessionTerminatedError({ code: account.state, message: account.stateMessage });
  }
  if (account.accessToken && isAccessTokenFresh(account.accessToken)) {
    return { entry: account.accessToken, freshlyMinted: false };
  }

  let refreshed;
  try {
    refreshed = await refreshClaudeCodeAccessToken(account.refreshToken, args.fetcher);
  } catch (error) {
    if (error instanceof ClaudeCodeOAuthSessionTerminatedError) {
      if (error.code === 'invalid_grant' && recoveryAllowed) {
        const recovered = await recoverFromRefreshRace(args, account.refreshToken);
        if (recovered) return recovered;
      }
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

// `invalid_grant` ambiguity: dead refresh token, or a sibling worker raced
// us and we hold the rotated-out copy. Re-read state and compare. The
// "sibling rotated but no cached access token yet" subcase (e.g. a
// concurrent `invalidateClaudeCodeAccessToken` cleared it) re-enters the
// refresh flow once with the fresh RT in hand; the depth guard prevents
// runaway recursion if recovery itself observes a stale view. Returns
// `null` when the original error should be re-raised as a real session
// termination.
const recoverFromRefreshRace = async (
  args: EnsureClaudeCodeAccessTokenArgs,
  usedRefreshToken: string,
): Promise<EnsuredAccessToken | null> => {
  const reread = await args.repo.getById(args.upstreamId);
  if (!reread) return null;
  const rereadState = readClaudeCodeUpstreamState(reread.state);
  const rereadAccount = rereadState.accounts[0];
  if (rereadAccount.state !== 'active') return null;
  if (rereadAccount.refreshToken === usedRefreshToken) return null;
  console.info(
    `Claude Code refresh-race recovered for upstream ${args.upstreamId}: sibling rotated, using their access token`,
  );
  if (rereadAccount.accessToken && isAccessTokenFresh(rereadAccount.accessToken)) {
    return { entry: rereadAccount.accessToken, freshlyMinted: false };
  }
  // Sibling rotated the refresh token but no usable access token sits in
  // state — most likely an `invalidateClaudeCodeAccessToken` ran between
  // the sibling's rotation and our re-read. Re-enter the refresh flow once
  // with the live RT; the re-entrant call sees the rotated row and goes
  // straight through the standard refresh path. The depth guard suppresses
  // a second recovery attempt — if `invalid_grant` strikes again the
  // refresh token really is dead and we want the terminal flip.
  return await ensureClaudeCodeAccessTokenInner(args, false);
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
  const account = state.accounts[accountIndex];
  if (account.accessToken === null) return;
  const cleared = replaceAccountAt(state, accountIndex, account => ({ ...account, accessToken: null }));
  await args.repo.saveState(args.upstreamId, cleared, { expectedState: fresh.state });
};
