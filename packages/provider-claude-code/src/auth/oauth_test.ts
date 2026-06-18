import { afterEach, describe, expect, test, vi } from 'vitest';

import {
  buildClaudeCodeAuthorizeUrl,
  ClaudeCodeOAuthSessionTerminatedError,
  exchangeClaudeCodeAuthorizationCode,
  refreshClaudeCodeAccessToken,
} from './oauth.ts';
import { directFetcher } from '@floway-dev/provider';

const okResponse = (body: unknown): Response =>
  new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } });
const errorResponse = (status: number, body: unknown): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

const tokenBody = {
  access_token: 'at',
  token_type: 'Bearer',
  expires_in: 3600,
  refresh_token: 'rt',
  scope: 'org:create_api_key user:profile user:inference',
};

afterEach(() => vi.restoreAllMocks());

describe('exchangeClaudeCodeAuthorizationCode', () => {
  test('POSTs JSON and returns parsed tokens', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse(tokenBody));
    const result = await exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER' });
    expect(result.access_token).toBe('at');
    expect(result.refresh_token).toBe('rt');
    expect(result.expires_in).toBe(3600);

    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe('https://platform.claude.com/v1/oauth/token');
    expect((init as RequestInit).method).toBe('POST');

    const headers = new Headers((init as RequestInit).headers);
    expect(headers.get('content-type')).toBe('application/json');
    expect(headers.get('user-agent')).toBe('axios/1.13.6');

    const body = JSON.parse((init as RequestInit).body as string);
    expect(body).toEqual({
      grant_type: 'authorization_code',
      code: 'CODE',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
      redirect_uri: 'https://platform.claude.com/oauth/code/callback',
      code_verifier: 'VER',
    });
  });

  test('throws session-terminated on invalid_grant', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: 'invalid_grant', error_description: 'Authorization code expired' }),
    );
    await expect(exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER' }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });

  test('throws session-terminated on app_session_terminated', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: { code: 'app_session_terminated', message: 'Session ended' } }),
    );
    await expect(exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER' }))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });

  test('throws generic error on non-terminal 4xx with status in message', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: 'invalid_request', error_description: 'missing redirect_uri' }),
    );
    await expect(exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER' }))
      .rejects.toThrow(/400/);
  });

  test('rethrows network failures unchanged', async () => {
    vi.spyOn(globalThis, 'fetch').mockRejectedValue(new TypeError('fetch failed'));
    await expect(exchangeClaudeCodeAuthorizationCode({ code: 'CODE', codeVerifier: 'VER' }))
      .rejects.toThrow('fetch failed');
  });
});

describe('refreshClaudeCodeAccessToken', () => {
  test('POSTs grant_type=refresh_token without scope', async () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(okResponse({
      ...tokenBody,
      access_token: 'at2',
      refresh_token: 'rt2',
    }));
    const result = await refreshClaudeCodeAccessToken('rt_old', directFetcher);
    expect(result.access_token).toBe('at2');
    expect(result.refresh_token).toBe('rt2');

    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string);
    expect(body).toEqual({
      grant_type: 'refresh_token',
      refresh_token: 'rt_old',
      client_id: '9d1c250a-e61b-44d9-88ed-5944d1962f5e',
    });
  });

  test('invalid_grant → ClaudeCodeOAuthSessionTerminatedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: 'invalid_grant', error_description: 'Refresh token revoked' }),
    );
    await expect(refreshClaudeCodeAccessToken('rt_dead', directFetcher))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });

  test('app_session_terminated → ClaudeCodeOAuthSessionTerminatedError', async () => {
    vi.spyOn(globalThis, 'fetch').mockResolvedValue(
      errorResponse(400, { error: { code: 'app_session_terminated', message: 'gone' } }),
    );
    await expect(refreshClaudeCodeAccessToken('rt_dead', directFetcher))
      .rejects.toBeInstanceOf(ClaudeCodeOAuthSessionTerminatedError);
  });
});

describe('buildClaudeCodeAuthorizeUrl', () => {
  test('emits all required PKCE + identity query params', () => {
    const url = buildClaudeCodeAuthorizeUrl({ state: 'csrf123', codeChallenge: 'CHAL' });
    const parsed = new URL(url);
    expect(parsed.origin + parsed.pathname).toBe('https://claude.ai/oauth/authorize');
    expect(parsed.searchParams.get('client_id')).toBe('9d1c250a-e61b-44d9-88ed-5944d1962f5e');
    expect(parsed.searchParams.get('response_type')).toBe('code');
    expect(parsed.searchParams.get('code')).toBe('true');
    expect(parsed.searchParams.get('redirect_uri')).toBe('https://platform.claude.com/oauth/code/callback');
    expect(parsed.searchParams.get('scope')).toContain('org:create_api_key');
    expect(parsed.searchParams.get('scope')).toContain('user:inference');
    expect(parsed.searchParams.get('state')).toBe('csrf123');
    expect(parsed.searchParams.get('code_challenge')).toBe('CHAL');
    expect(parsed.searchParams.get('code_challenge_method')).toBe('S256');
  });
});
