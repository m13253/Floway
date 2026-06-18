import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest';

import {
  ensureClaudeCodeAccessToken,
  invalidateClaudeCodeAccessToken,
  type ClaudeCodeAccessTokenEntry,
} from './access-token-cache.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import type { ClaudeCodeUpstreamConfig } from './config.ts';
import type { ClaudeCodeUpstreamState } from './state.ts';
import { directFetcher, type UpstreamRecord, type UpstreamsRepoSlim } from '@floway-dev/provider';

const accountUuid = 'acc-uuid-1';
const upstreamId = 'up-claude-1';

const baseConfig: ClaudeCodeUpstreamConfig = {
  accounts: [{
    email: 'user@example.com',
    accountUuid,
    organizationUuid: 'org-uuid-1',
    subscriptionType: 'max_20x',
  }],
};

const makeRecord = (state: ClaudeCodeUpstreamState): UpstreamRecord => ({
  id: upstreamId,
  provider: 'claude-code',
  name: 'Claude Code',
  enabled: true,
  sortOrder: 0,
  createdAt: '2026-06-01T00:00:00.000Z',
  updatedAt: '2026-06-01T00:00:00.000Z',
  config: baseConfig,
  state,
  flagOverrides: {},
  disabledPublicModelIds: [],
  proxyFallbackList: [],
});

const baseAccount: ClaudeCodeUpstreamState['accounts'][number] = {
  accountUuid,
  refreshToken: 'rt_v1',
  state: 'active',
  stateUpdatedAt: '2026-06-01T00:00:00.000Z',
  accessToken: null,
  quotaSnapshot: null,
};

const farFutureMs = Date.now() + 24 * 60 * 60 * 1000;

type SaveStateSpy = ReturnType<typeof vi.fn<(id: string, newState: unknown, opts: { expectedState: unknown }) => Promise<{ updated: boolean }>>>;
type GetByIdSpy = ReturnType<typeof vi.fn<(id: string) => Promise<UpstreamRecord | null>>>;

let current: UpstreamRecord | null;
let saveStateSpy: SaveStateSpy;
let getByIdSpy: GetByIdSpy;
let repo: UpstreamsRepoSlim;

beforeEach(() => {
  current = makeRecord({ accounts: [{ ...baseAccount }] });
  // Write-through stub: a successful CAS mutates the in-memory record so a
  // follow-up getById observes the latest persisted state. Mirrors the
  // live D1-backed repo's read-after-write behavior.
  saveStateSpy = vi.fn(async (_id, newState, _opts) => {
    if (current) current = { ...current, state: newState as ClaudeCodeUpstreamState };
    return { updated: true };
  });
  getByIdSpy = vi.fn(async () => current);
  repo = { getById: getByIdSpy, saveState: saveStateSpy };
});

afterEach(() => vi.restoreAllMocks());

describe('ensureClaudeCodeAccessToken', () => {
  test('returns the cached entry when still fresh and never calls fetch', async () => {
    const entry: ClaudeCodeAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out).toEqual(entry);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('refreshes when no token is cached, rotates refresh_token via CAS, persists fresh access token', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));

    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.token).toBe('at_new');
    expect(out.expiresAt).toBeGreaterThan(Date.now());

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const [, nextState] = saveStateSpy.mock.calls[0];
    const account = (nextState as ClaudeCodeUpstreamState).accounts[0];
    expect(account.refreshToken).toBe('rt_v2');
    expect(account.accessToken?.token).toBe('at_new');
    expect(account.state).toBe('active');
  });

  test('refreshes when the cached token is within the 5-minute skew window', async () => {
    const expiresSoon = Date.now() + 60 * 1000;
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: { token: 'at_old', expiresAt: expiresSoon, refreshedAt: 'old' } }] });
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    const out = await ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher });
    expect(out.token).toBe('at_new');
  });

  test('throws ClaudeCodeOAuthSessionTerminatedError when refresh returns invalid_grant, and flips state to refresh_failed', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      error: 'invalid_grant', error_description: 'Refresh token revoked',
    }), { status: 400, headers: { 'content-type': 'application/json' } }));

    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);

    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].state).toBe('refresh_failed');
    expect(persisted.accounts[0].stateMessage).toContain('Refresh token revoked');
    expect(persisted.accounts[0].accessToken).toBeNull();
  });

  test('CAS loss on refresh-token rotation surfaces as an error (sibling rotation already won)', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    saveStateSpy.mockResolvedValueOnce({ updated: false });
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/CAS/);
  });

  test('saveState storage failure propagates without rotating', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(JSON.stringify({
      access_token: 'at_new', token_type: 'Bearer', expires_in: 3600, refresh_token: 'rt_v2', scope: 'user:inference',
    }), { status: 200, headers: { 'content-type': 'application/json' } }));
    saveStateSpy.mockRejectedValueOnce(new Error('D1 boom'));
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/D1 boom/);
  });

  test('throws when the upstream row is missing', async () => {
    current = null;
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toThrow(/not found/);
  });

  test('throws session-terminated when the stored account is not active', async () => {
    current = makeRecord({
      accounts: [{ ...baseAccount, state: 'refresh_failed', stateMessage: 'previously failed', stateUpdatedAt: 'now' }],
    });
    await expect(ensureClaudeCodeAccessToken({ upstreamId, repo, fetcher: directFetcher }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });
});

describe('invalidateClaudeCodeAccessToken', () => {
  test('clears a populated access-token slot', async () => {
    const entry: ClaudeCodeAccessTokenEntry = { token: 'at_x', expiresAt: farFutureMs, refreshedAt: 'now' };
    current = makeRecord({ accounts: [{ ...baseAccount, accessToken: entry }] });
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    expect(saveStateSpy).toHaveBeenCalledTimes(1);
    const persisted = saveStateSpy.mock.calls[0][1] as ClaudeCodeUpstreamState;
    expect(persisted.accounts[0].accessToken).toBeNull();
    expect(persisted.accounts[0].refreshToken).toBe('rt_v1');
  });

  test('no-ops when the slot is already null', async () => {
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    expect(saveStateSpy).not.toHaveBeenCalled();
  });

  test('no-ops when the upstream disappeared', async () => {
    current = null;
    await invalidateClaudeCodeAccessToken({ upstreamId, repo });
    expect(saveStateSpy).not.toHaveBeenCalled();
  });
});
