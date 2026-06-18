import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  extractClaudeCodeCallbackParams,
  importClaudeCodeFromCallback,
  importClaudeCodeFromCredentialsJson,
} from './import.ts';
import { directFetcher, type Fetcher } from '@floway-dev/provider';

const profileResponse = {
  account: {
    uuid: 'acc-uuid-1',
    email: 'user@example.com',
    has_claude_max: true,
    has_claude_pro: false,
    display_name: 'User',
  },
  organization: {
    uuid: 'org-uuid-1',
    organization_type: 'claude_max',
    rate_limit_tier: 'default_claude_max_20x',
    billing_type: 'subscription',
  },
};

const tokenResponse = {
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt',
  scope: 'user:inference',
};

const jsonResponse = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

afterEach(() => vi.restoreAllMocks());

describe('extractClaudeCodeCallbackParams', () => {
  test('parses the official callback URL', () => {
    const params = extractClaudeCodeCallbackParams('https://platform.claude.com/oauth/code/callback?code=CODE&state=STATE');
    expect(params).toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('parses a bare query string with leading ?', () => {
    expect(extractClaudeCodeCallbackParams('?code=CODE&state=STATE')).toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('parses a bare query string without leading ?', () => {
    expect(extractClaudeCodeCallbackParams('code=CODE&state=STATE')).toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('parses a host-relative URL by slicing at the first ?', () => {
    expect(extractClaudeCodeCallbackParams('platform.claude.com/oauth/code/callback?code=CODE&state=STATE'))
      .toEqual({ code: 'CODE', state: 'STATE' });
  });

  test('throws on missing code', () => {
    expect(() => extractClaudeCodeCallbackParams('https://platform.claude.com/oauth/code/callback?state=S'))
      .toThrow(/code/);
  });

  test('throws on missing state', () => {
    expect(() => extractClaudeCodeCallbackParams('https://platform.claude.com/oauth/code/callback?code=C'))
      .toThrow(/state/);
  });

  test('throws on empty input', () => {
    expect(() => extractClaudeCodeCallbackParams('   ')).toThrow();
  });

  test('throws on malformed http URL', () => {
    expect(() => extractClaudeCodeCallbackParams('https://')).toThrow();
  });
});

describe('importClaudeCodeFromCallback', () => {
  test('exchanges code, fetches profile, builds config + state', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(jsonResponse(tokenResponse))
      .mockResolvedValueOnce(jsonResponse(profileResponse));

    const result = await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER' });

    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://platform.claude.com/v1/oauth/token');
    expect(fetchSpy.mock.calls[1][0]).toBe('https://api.anthropic.com/api/oauth/profile');
    const profileInit = fetchSpy.mock.calls[1][1] as RequestInit;
    expect(new Headers(profileInit.headers).get('authorization')).toBe('Bearer at');

    expect(result.config.accounts).toEqual([{
      email: 'user@example.com',
      accountUuid: 'acc-uuid-1',
      organizationUuid: 'org-uuid-1',
      subscriptionType: 'max_20x',
    }]);
    expect(result.state.accounts[0].accountUuid).toBe('acc-uuid-1');
    expect(result.state.accounts[0].refreshToken).toBe('rt');
    expect(result.state.accounts[0].state).toBe('active');
    expect(result.state.accounts[0].accessToken?.token).toBe('at');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBeGreaterThan(Date.now());
  });

  test('passes the supplied fetcher through to the profile call', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(tokenResponse));
    const fetcher: Fetcher = vi.fn(async () => jsonResponse(profileResponse));
    await importClaudeCodeFromCallback({ code: 'CODE', pkceVerifier: 'VER', fetcher });
    // Token-exchange routes through the global fetch (directFetcher); only
    // the profile call honours the per-upstream fetcher.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect((fetcher as ReturnType<typeof vi.fn>).mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/profile');
  });
});

describe('importClaudeCodeFromCredentialsJson', () => {
  const farFutureMs = Date.now() + 30 * 60 * 1000;

  test('happy path uses CLI subscriptionType verbatim and reuses the access token', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse(profileResponse));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'sk-ant-oat01-x',
        refreshToken: 'sk-ant-ort01-y',
        expiresAt: farFutureMs,
        scopes: ['org:create_api_key', 'user:profile'],
        subscriptionType: 'max_20x',
      },
    });

    const result = await importClaudeCodeFromCredentialsJson(raw, directFetcher);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(fetchSpy.mock.calls[0][0]).toBe('https://api.anthropic.com/api/oauth/profile');
    expect(result.config.accounts[0].subscriptionType).toBe('max_20x');
    expect(result.config.accounts[0].email).toBe('user@example.com');
    expect(result.state.accounts[0].refreshToken).toBe('sk-ant-ort01-y');
    expect(result.state.accounts[0].accessToken?.token).toBe('sk-ant-oat01-x');
    expect(result.state.accounts[0].accessToken?.expiresAt).toBe(farFutureMs);
  });

  test('falls back to derived subscriptionType when CLI field is absent', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({
      ...profileResponse,
      organization: { ...profileResponse.organization, rate_limit_tier: 'default_claude_max_5x' },
    }));
    const raw = JSON.stringify({
      claudeAiOauth: {
        accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs,
      },
    });
    const result = await importClaudeCodeFromCredentialsJson(raw, directFetcher);
    expect(result.config.accounts[0].subscriptionType).toBe('max_5x');
  });

  test('rejects when JSON is malformed', async () => {
    await expect(importClaudeCodeFromCredentialsJson('{ not json')).rejects.toThrow();
  });

  test('rejects when claudeAiOauth wrapper is missing', async () => {
    await expect(importClaudeCodeFromCredentialsJson(JSON.stringify({}))).rejects.toThrow(/claudeAiOauth/);
  });

  test('rejects when accessToken is missing', async () => {
    const raw = JSON.stringify({ claudeAiOauth: { refreshToken: 'r', expiresAt: farFutureMs } });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/accessToken/);
  });

  test('rejects when expiresAt looks like seconds rather than milliseconds', async () => {
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: 1781234567 },
    });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/milliseconds/);
  });

  test('surfaces profile API failure', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValueOnce(jsonResponse({ error: 'unauthorized' }, 401));
    const raw = JSON.stringify({
      claudeAiOauth: { accessToken: 'a', refreshToken: 'r', expiresAt: farFutureMs },
    });
    await expect(importClaudeCodeFromCredentialsJson(raw)).rejects.toThrow(/401/);
  });
});
