import { ensureCodexAccessToken, invalidateCodexAccessToken } from './access-token-cache.ts';
import { CodexOAuthSessionTerminatedError, refreshCodexAccessToken } from './auth/oauth.ts';
import {
  CODEX_BACKEND_BASE,
  CODEX_ORIGINATOR,
  CODEX_RESPONSES_PATH,
  CODEX_USER_AGENT,
} from './constants.ts';
import {
  getCodexQuota,
  isCodexRateLimited,
  parseCodexQuotaHeaders,
  putCodexQuota,
} from './quota.ts';
import type { CodexAccountCredential } from './state.ts';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { parseResponsesStream } from '@floway-dev/protocols/responses';
import { streamingProviderCall, type ProviderStreamResult, type UpstreamCallOptions, type UpstreamModel } from '@floway-dev/provider';

// Hooks for repo-side state transitions, applied with optimistic concurrency.
// Refresh-token rotations and terminal-state transitions go through the repo;
// access-token and quota persistence are handled inside their own helpers
// (also state_json writes via the same CAS hook).
export interface CodexCallEffects {
  persistRefreshTokenRotation(newRefreshToken: string): Promise<void>;
  persistTerminalState(state: 'session_terminated' | 'refresh_failed', message: string): Promise<void>;
}

// The transport is account-agnostic — the caller selects the credential
// and passes it in.
export interface CallCodexResponsesOptions {
  upstreamId: string;
  account: CodexAccountCredential;
  model: UpstreamModel;
  body: Omit<ResponsesPayload, 'model'>;
  headers: Record<string, string>;
  signal?: AbortSignal;
  effects: CodexCallEffects;
  // Per-call options; see UpstreamCallOptions for the fetcher /
  // recordUpstreamLatency contract. The recorder is threaded into the
  // /responses fetcher's per-attempt wrap; the OAuth refresh hop calls the
  // fetcher unwrapped because it is the gateway's own auth maintenance,
  // not part of the user's upstream round-trip.
  call: UpstreamCallOptions;
}

export const callCodexResponses = async (opts: CallCodexResponsesOptions): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  // Pre-fetch gates short-circuit before reaching the network. The gateway
  // recorder still needs the contract observed (it throws on a provider that
  // returns without ever wrapping), so each synthetic response rides through
  // `recordUpstreamLatency` once. The captured ~0 ms is never read — the
  // gateway records `upstream_success` failures as a counter, not a latency.
  const syntheticReturn = async (response: Response): Promise<ProviderStreamResult<ResponsesStreamEvent>> => ({
    ok: false,
    modelKey: opts.model.id,
    response: await opts.call.recordUpstreamLatency(Promise.resolve(response)),
  });

  if (opts.account.state !== 'active') {
    return await syntheticReturn(synthetic503(`Codex upstream is ${opts.account.state}`));
  }

  const now = new Date();
  const quotaSnapshot = await getCodexQuota(opts.upstreamId, opts.account.chatgptAccountId);
  if (isCodexRateLimited(quotaSnapshot, now)) {
    return await syntheticReturn(
      synthetic429(`Codex upstream rate-limited until ${quotaSnapshot!.ratelimited_until!}`, quotaSnapshot!.ratelimited_until!, now),
    );
  }

  let accessToken: string;
  try {
    accessToken = await ensureAccessToken(opts);
  } catch (err) {
    if (err instanceof CodexOAuthSessionTerminatedError) {
      await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
      return await syntheticReturn(synthetic503(`Codex refresh failed: ${err.upstreamMessage}`));
    }
    throw err;
  }

  return await performUpstreamCall(opts, accessToken, false);
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
const mintAccessToken = async (opts: CallCodexResponsesOptions, refreshToken: string) => {
  const tokens = await refreshCodexAccessToken(refreshToken, opts.call.fetcher);
  await opts.effects.persistRefreshTokenRotation(tokens.refresh_token);
  return {
    token: tokens.access_token,
    expiresAt: Date.now() + tokens.expires_in * 1000,
    refreshedAt: new Date().toISOString(),
  };
};

const ensureAccessToken = async (opts: CallCodexResponsesOptions): Promise<string> => {
  const entry = await ensureCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId, refresh => mintAccessToken(opts, refresh));
  return entry.token;
};

const performUpstreamCall = async (
  opts: CallCodexResponsesOptions,
  accessToken: string,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<ResponsesStreamEvent>> => {
  const headers: Record<string, string> = {
    ...opts.headers,
    'authorization': `Bearer ${accessToken}`,
    'chatgpt-account-id': opts.account.chatgptAccountId,
    'originator': CODEX_ORIGINATOR,
    'user-agent': CODEX_USER_AGENT,
    'accept': 'text/event-stream',
    'content-type': 'application/json',
  };

  const upstreamFetch = opts.call.fetcher(`${CODEX_BACKEND_BASE}${CODEX_RESPONSES_PATH}`, {
    method: 'POST',
    headers,
    body: JSON.stringify({ ...opts.body, model: opts.model.id, store: false, stream: true }),
    signal: opts.signal,
  }, opts.call.recordUpstreamLatency).then(async response => {
    if (response.ok) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: false });
      // Quota persistence is best-effort — getCodexQuota already treats a
      // missing or stale snapshot as null, so a CAS loss or transient
      // storage error is recoverable noise rather than something to crash
      // the request on.
      putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot).catch(() => {});
      return ensureSseContentType(response);
    }

    if (response.status === 429) {
      const responseNow = new Date();
      const snapshot = parseCodexQuotaHeaders(response.headers, { now: responseNow, isRateLimited: true });
      putCodexQuota(opts.upstreamId, opts.account.chatgptAccountId, snapshot).catch(() => {});
      return response;
    }

    if (response.status === 401) {
      const bodyText = await response.text();
      const { code, message } = parseUpstreamError(bodyText);
      if (code === 'token_invalidated') {
        await opts.effects.persistTerminalState('session_terminated', message);
        return synthetic503(`Codex session terminated: ${message}`);
      }
      return new Response(bodyText, { status: 401, headers: response.headers });
    }

    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseResponsesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && !alreadyRetried) {
    await invalidateCodexAccessToken(opts.upstreamId, opts.account.chatgptAccountId);
    let newAccessToken: string;
    try {
      newAccessToken = await ensureAccessToken(opts);
    } catch (err) {
      if (err instanceof CodexOAuthSessionTerminatedError) {
        await opts.effects.persistTerminalState('refresh_failed', err.upstreamMessage);
        return { ok: false, modelKey: opts.model.id, response: synthetic503(`Codex refresh failed: ${err.upstreamMessage}`) };
      }
      throw err;
    }
    return await performUpstreamCall(opts, newAccessToken, true);
  }

  return result;
};

const parseUpstreamError = (rawText: string): { code: string | null; message: string } => {
  try {
    const obj = JSON.parse(rawText) as { error?: { code?: unknown; message?: unknown }; detail?: unknown };
    const code = obj.error && typeof obj.error === 'object' && typeof obj.error.code === 'string' ? obj.error.code : null;
    const message = obj.error && typeof obj.error === 'object' && typeof obj.error.message === 'string'
      ? obj.error.message
      : typeof obj.detail === 'string' ? obj.detail : rawText.slice(0, 256);
    return { code, message };
  } catch {
    return { code: null, message: rawText.slice(0, 256) };
  }
};

const synthetic503 = (message: string): Response => new Response(JSON.stringify({ error: { type: 'codex_upstream_unavailable', message } }), {
  status: 503,
  headers: { 'content-type': 'application/json' },
});

const synthetic429 = (message: string, retryAtIso: string, now: Date): Response => {
  const retryAfterSeconds = Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000));
  return new Response(JSON.stringify({ error: { type: 'codex_rate_limited', message, retry_at: retryAtIso } }), {
    status: 429,
    headers: { 'content-type': 'application/json', 'retry-after': String(retryAfterSeconds) },
  });
};

// Codex backend serves SSE without setting `content-type: text/event-stream`
// (observed in production: only x-codex-* + standard CDN headers come back).
// The shared `streamingProviderCall` rejects 2xx responses lacking the SSE
// content-type as a contract violation, so we synthesize the header on the
// way through. Body stream is preserved verbatim.
const ensureSseContentType = (response: Response): Response => {
  if (response.headers.get('content-type')?.includes('text/event-stream')) return response;
  const headers = new Headers(response.headers);
  headers.set('content-type', 'text/event-stream');
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
};
