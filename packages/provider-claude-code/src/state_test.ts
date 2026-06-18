import { describe, expect, test } from 'vitest';

import { assertClaudeCodeUpstreamState, readClaudeCodeUpstreamState, type ClaudeCodeUpstreamState } from './state.ts';

const goodAccount = {
  accountUuid: 'aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa',
  refreshToken: 'sk-ant-ort01-rt',
  state: 'active' as const,
  stateUpdatedAt: '2026-06-19T00:00:00Z',
};
const good: ClaudeCodeUpstreamState = {
  accounts: [{ ...goodAccount, accessToken: null, quotaSnapshot: null }],
};

describe('assertClaudeCodeUpstreamState', () => {
  test('accepts active state', () => {
    expect(() => assertClaudeCodeUpstreamState(good)).not.toThrow();
  });
  test('accepts terminal states with stateMessage', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        state: 'session_terminated',
        stateMessage: 'Token revoked',
      }],
    })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'refresh_failed', stateMessage: 'Refresh failed' }],
    })).not.toThrow();
  });
  test('rejects terminal state without stateMessage', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'refresh_failed' }],
    })).toThrow(/stateMessage/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, state: 'session_terminated', stateMessage: '' }],
    })).toThrow(/stateMessage/);
  });
  test('rejects stateMessage on active state', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, stateMessage: 'shouldnt be here' }],
    })).toThrow(/stateMessage/);
  });
  test('rejects missing stateUpdatedAt', () => {
    const { stateUpdatedAt: _drop, ...withoutTimestamp } = goodAccount;
    expect(() => assertClaudeCodeUpstreamState({ accounts: [withoutTimestamp] })).toThrow(/stateUpdatedAt/);
  });
  test('rejects empty refreshToken', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, refreshToken: '' }] })).toThrow(/refreshToken/);
  });
  test('rejects empty accountUuid', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, accountUuid: '' }] })).toThrow(/accountUuid/);
  });
  test('rejects unknown state value', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, state: 'broken' }] })).toThrow(/state/);
  });
  test('rejects null / undefined / non-objects', () => {
    expect(() => assertClaudeCodeUpstreamState(null)).toThrow();
    expect(() => assertClaudeCodeUpstreamState(undefined)).toThrow();
    expect(() => assertClaudeCodeUpstreamState('s')).toThrow();
  });
  test('rejects unexpected keys at the top level', () => {
    expect(() => assertClaudeCodeUpstreamState({ ...good, extraField: 'x' })).toThrow(/extraField/);
  });
  test('rejects unexpected keys inside an account', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, smuggled: 'x' }] })).toThrow(/smuggled/);
  });
  test('rejects an empty accounts array (v1 invariant: exactly one)', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [] })).toThrow(/exactly one/);
  });
  test('rejects multiple accounts (v1 invariant: exactly one)', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [goodAccount, { ...goodAccount, accountUuid: 'bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb' }],
    })).toThrow(/exactly one/);
  });

  test('accepts accessToken absent / null / populated', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, accessToken: null }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-19T00:00:00Z' },
      }],
    })).not.toThrow();
  });
  test('rejects malformed accessToken', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: '', expiresAt: 1, refreshedAt: 'x' } }],
    })).toThrow(/token/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 'soon', refreshedAt: 'x' } }],
    })).toThrow(/expiresAt/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, accessToken: { token: 'at', expiresAt: 1, refreshedAt: 'x', extra: 1 } }],
    })).toThrow(/extra/);
  });

  test('accepts quotaSnapshot absent / null / populated', () => {
    expect(() => assertClaudeCodeUpstreamState({ accounts: [{ ...goodAccount, quotaSnapshot: null }] })).not.toThrow();
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{
        ...goodAccount,
        quotaSnapshot: { fetchedAt: 1_700_000_000_000, data: { status: 'allowed' } },
      }],
    })).not.toThrow();
  });
  test('rejects malformed quotaSnapshot', () => {
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 'soon', data: {} } }],
    })).toThrow(/fetchedAt/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 1, data: 'oops' } }],
    })).toThrow(/data/);
    expect(() => assertClaudeCodeUpstreamState({
      accounts: [{ ...goodAccount, quotaSnapshot: { fetchedAt: 1, data: {}, extra: 1 } }],
    })).toThrow(/extra/);
  });
});

describe('readClaudeCodeUpstreamState', () => {
  test('normalizes absent accessToken / quotaSnapshot to null', () => {
    const out = readClaudeCodeUpstreamState({ accounts: [{ ...goodAccount }] });
    expect(out.accounts[0].accessToken).toBeNull();
    expect(out.accounts[0].quotaSnapshot).toBeNull();
  });
  test('preserves populated entries verbatim', () => {
    const populated = {
      accounts: [{
        ...goodAccount,
        accessToken: { token: 'at', expiresAt: 1_700_000_000_000, refreshedAt: '2026-06-19T00:00:00Z' },
        quotaSnapshot: { fetchedAt: 1_700_000_000_000, data: { status: 'allowed' } },
      }],
    };
    const out = readClaudeCodeUpstreamState(populated);
    expect(out.accounts[0].accessToken).toEqual(populated.accounts[0].accessToken);
    expect(out.accounts[0].quotaSnapshot).toEqual(populated.accounts[0].quotaSnapshot);
  });
});
