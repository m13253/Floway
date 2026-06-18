import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken } from './access-token-cache.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { parseClaudeCodeQuotaHeaders, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import {
  readClaudeCodeUpstreamState,
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamState,
} from './state.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { parseMessagesStream } from '@floway-dev/protocols/messages';
import {
  getProviderRepo,
  streamingProviderCall,
  type ProviderStreamResult,
  type UpstreamCallOptions,
  type UpstreamModel,
} from '@floway-dev/provider';

const ANTHROPIC_MESSAGES_ENDPOINT = 'https://api.anthropic.com/v1/messages?beta=true';

// Detection helper: the periodic CC connectivity probe sends `max_tokens: 1`
// against a haiku id (model name substring 'haiku') and never carries a
// system block. Surfacing those as CC-shaped lets them pass through without
// re-mimicry overhead, matching real CC's wire shape exactly.
export const detectHaikuProbe = (body: { model?: unknown; max_tokens?: unknown }): boolean => {
  return typeof body.model === 'string'
    && body.model.includes('haiku')
    && body.max_tokens === 1;
};

export interface CallClaudeCodeMessagesOptions {
  upstreamId: string;
  model: UpstreamModel;
  body: Omit<MessagesPayload, 'model'>;
  headers: Record<string, string>;
  // `shaped: true` means the inbound request already looks like real CC
  // traffic (operator's CC client sent through verbatim); preserve the
  // caller's header surface and only swap Authorization. `shaped: false`
  // means the gateway's re-mimicry chain has already rebuilt the payload's
  // system blocks / metadata / model id — replace headers with the pinned
  // CC set so the wire shape matches end-to-end.
  shaped: boolean;
  signal?: AbortSignal;
  call: UpstreamCallOptions;
}

const syntheticResponse = (status: number, body: unknown, extraHeaders: Record<string, string> = {}): Response =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...extraHeaders } });

const synthetic503 = (message: string): Response =>
  syntheticResponse(503, { error: { type: 'claude_code_upstream_unavailable', message } });

const synthetic429 = (message: string, retryAtIso: string | null, now: Date): Response => {
  const retryAfterSeconds = retryAtIso === null
    ? 60
    : Math.max(0, Math.ceil((new Date(retryAtIso).getTime() - now.getTime()) / 1000));
  return syntheticResponse(
    429,
    { error: { type: 'claude_code_rate_limited', message, retry_at: retryAtIso } },
    { 'retry-after': String(retryAfterSeconds) },
  );
};

// `anthropic-ratelimit-unified-status: rejected` or an overage-rejected snapshot
// means the upstream would 429 anything we send right now; short-circuit at
// the gate so we don't burn an OAuth refresh on a request that has no chance.
const isRateLimitedNow = (
  snapshot: ClaudeCodeQuotaSnapshot | null,
  now: Date,
): snapshot is ClaudeCodeQuotaSnapshot => {
  if (!snapshot) return false;
  if (snapshot.status === 'rejected') {
    if (!snapshot.reset) return true;
    return new Date(snapshot.reset).getTime() > now.getTime();
  }
  if (snapshot.overage?.status === 'rejected') {
    if (!snapshot.overage.reset) return true;
    return new Date(snapshot.overage.reset).getTime() > now.getTime();
  }
  return false;
};

const findStateAccount = (state: ClaudeCodeUpstreamState): ClaudeCodeAccountCredential => state.accounts[0]!;

const replaceStateAccount = (
  state: ClaudeCodeUpstreamState,
  patch: (account: ClaudeCodeAccountCredential) => ClaudeCodeAccountCredential,
): ClaudeCodeUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, i) => (i === 0 ? patch(account) : account)),
});

// Quota persistence is best-effort: a CAS loss to a concurrent rotation or
// quota write is fine because the live state already carries a snapshot at
// least as fresh as the one we'd write.
const persistQuotaSnapshot = async (upstreamId: string, snapshot: ClaudeCodeQuotaSnapshot): Promise<void> => {
  const fresh = await getProviderRepo().upstreams.getById(upstreamId);
  if (!fresh) return;
  const state = readClaudeCodeUpstreamState(fresh.state);
  const next = replaceStateAccount(state, account => ({
    ...account,
    quotaSnapshot: { fetchedAt: Date.now(), data: snapshot },
  }));
  await getProviderRepo().upstreams.saveState(upstreamId, next, { expectedState: fresh.state });
};

const fireAndForgetPersist = (upstreamId: string, headers: Headers): void => {
  const snapshot = parseClaudeCodeQuotaHeaders(headers);
  // Skip when the response carries no rate-limit signal at all — there is
  // nothing meaningful to persist and writing an empty object would erase
  // the prior snapshot.
  if (Object.keys(snapshot.raw).length === 0) return;
  persistQuotaSnapshot(upstreamId, snapshot).catch(error => {
    console.warn(`Claude Code: failed to persist quota snapshot for upstream ${upstreamId}: ${String(error)}`);
  });
};

export const callClaudeCodeMessages = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  // recordUpstreamLatency contract: every code path that returns must wrap
  // exactly one fetch (real or synthetic). Synthetic gates ride a resolved
  // promise so the gateway's recorder sees the contract met without
  // measuring anything meaningful.
  const syntheticReturn = async (response: Response): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: false,
    modelKey: opts.model.id,
    response: await opts.call.recordUpstreamLatency(Promise.resolve(response)),
  });

  const fresh = await getProviderRepo().upstreams.getById(opts.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${opts.upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = findStateAccount(state);

  if (account.state !== 'active') {
    return await syntheticReturn(synthetic503(
      `Claude Code account is ${account.state}: ${account.stateMessage}`,
    ));
  }

  const now = new Date();
  const quotaData = account.quotaSnapshot?.data ?? null;
  if (isRateLimitedNow(quotaData, now)) {
    const resetIso = quotaData.reset ?? quotaData.overage?.reset ?? null;
    return await syntheticReturn(synthetic429(
      resetIso ? `Claude Code upstream rate-limited until ${resetIso}` : 'Claude Code upstream rate-limited',
      resetIso,
      now,
    ));
  }

  let accessToken: ResolvedToken;
  try {
    const ensured = await ensureClaudeCodeAccessToken({
      upstreamId: opts.upstreamId,
      repo: getProviderRepo().upstreams,
      fetcher: opts.call.fetcher,
    });
    accessToken = { token: ensured.entry.token, freshlyMinted: ensured.freshlyMinted };
  } catch (err) {
    if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
      // ensureClaudeCodeAccessToken already persisted the terminal state.
      return await syntheticReturn(synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`));
    }
    throw err;
  }

  return await performUpstreamCall(opts, accessToken, false);
};

interface ResolvedToken {
  token: string;
  freshlyMinted: boolean;
}

const performUpstreamCall = async (
  opts: CallClaudeCodeMessagesOptions,
  accessToken: ResolvedToken,
  alreadyRetried: boolean,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  let headers: Record<string, string>;
  if (opts.shaped) {
    // Spread first, then drop any inbound auth header in either casing before
    // setting ours. `clientRequestHeaders` is documented lowercase-only
    // (`UpstreamCallOptions` JSDoc), so the uppercase delete is defensive
    // insurance, not a real expectation.
    const passthrough: Record<string, string> = { ...opts.headers };
    delete passthrough.authorization;
    delete passthrough.Authorization;
    headers = { ...passthrough, authorization: `Bearer ${accessToken.token}` };
  } else {
    headers = { ...pickClaudeCodeHeaders(opts.model.id), 'Content-Type': 'application/json', authorization: `Bearer ${accessToken.token}` };
  }

  // Force stream:true regardless of caller intent. The streaming envelope is
  // what the gateway boundary expects; non-streaming Messages is routed
  // elsewhere. Safe in the shaped passthrough path too: shaped detection
  // requires CC client headers + system blocks + a valid metadata.user_id,
  // and the real Claude Code client always sets `stream: true`.
  const wireBody: MessagesPayload = { ...opts.body, model: opts.model.id, stream: true };

  const upstreamFetch = opts.call.fetcher(ANTHROPIC_MESSAGES_ENDPOINT, {
    method: 'POST',
    headers,
    body: JSON.stringify(wireBody),
    signal: opts.signal,
  }, opts.call.recordUpstreamLatency).then(response => {
    // Every Anthropic response (2xx or 429) ships an
    // `anthropic-ratelimit-unified-*` snapshot; capture both so the rate-
    // limited gate above stays accurate as the window evolves. Other
    // statuses (4xx/5xx outside 429) carry no quota signal so we skip them.
    if (response.ok || response.status === 429) {
      fireAndForgetPersist(opts.upstreamId, response.headers);
    }
    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseMessagesStream, opts.model.id, opts.signal);

  if (!result.ok && result.response.status === 401 && !accessToken.freshlyMinted && !alreadyRetried) {
    // Cached token rejected; invalidate so the next mint reads stale=null,
    // then re-enter with a fresh-minted token. A second 401 (alreadyRetried
    // == true) means the refresh_token itself is the problem and the
    // operator has to re-import — surface the 401 verbatim so the gateway
    // boundary reports the real upstream message rather than masking it.
    await invalidateClaudeCodeAccessToken({
      upstreamId: opts.upstreamId,
      repo: getProviderRepo().upstreams,
    });
    let nextToken: ResolvedToken;
    try {
      const ensured = await ensureClaudeCodeAccessToken({
        upstreamId: opts.upstreamId,
        repo: getProviderRepo().upstreams,
        fetcher: opts.call.fetcher,
      });
      nextToken = { token: ensured.entry.token, freshlyMinted: ensured.freshlyMinted };
    } catch (err) {
      if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
        return {
          ok: false,
          modelKey: opts.model.id,
          response: synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`),
        };
      }
      throw err;
    }
    return await performUpstreamCall(opts, nextToken, true);
  }

  return result;
};
