import { ensureClaudeCodeAccessToken, invalidateClaudeCodeAccessToken, type EnsuredAccessToken } from './access-token-cache.ts';
import { ClaudeCodeOAuthSessionTerminatedError } from './auth/oauth.ts';
import { pickClaudeCodeHeaders } from './headers.ts';
import { parseClaudeCodeQuotaHeaders, type ClaudeCodeQuotaSnapshot } from './quota.ts';
import {
  readClaudeCodeUpstreamState,
  type ClaudeCodeAccountCredential,
  type ClaudeCodeUpstreamState,
} from './state.ts';
import type { ClaudeCodeProviderData } from './types.ts';
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

// `anthropic-ratelimit-unified-status: rejected` paired with a future
// `unified-reset` timestamp means the upstream's primary plan window is
// exhausted and a fresh request would 429 right away; short-circuit at
// the gate so we don't burn an OAuth refresh on a request that has no
// chance.
//
// Note 1: `overage.status: rejected` (typically paired with
// `overage-disabled-reason: out_of_credits`) is NOT a short-circuit
// signal. It only reports that the account has no extra-usage credits
// to spill into once the primary window runs out — which is the steady
// state for any plan-tier account that hasn't bought extra credits, so
// blocking on it would refuse every request to such accounts. The
// primary `status` already reflects whether the upstream will actually
// reject the next request.
//
// Note 2: a primary `status: rejected` WITHOUT a `reset` is treated as
// non-gating. Sub2api `ratelimit_service.go:953-961` flags this exact
// shape as "likely not a real rate limit" (e.g. an "Extra usage required"
// body sentinel) and passes it through verbatim — without a reset we'd
// otherwise lock the account out indefinitely because the next request
// never fires to refresh the snapshot.
const isRateLimitedNow = (
  snapshot: ClaudeCodeQuotaSnapshot | null,
  now: Date,
): snapshot is ClaudeCodeQuotaSnapshot => {
  if (!snapshot) return false;
  if (snapshot.status !== 'rejected') return false;
  if (!snapshot.reset) return false;
  return new Date(snapshot.reset).getTime() > now.getTime();
};

const replaceStateAccount = (
  state: ClaudeCodeUpstreamState,
  patch: (account: ClaudeCodeAccountCredential) => ClaudeCodeAccountCredential,
): ClaudeCodeUpstreamState => ({
  ...state,
  accounts: state.accounts.map((account, i) => (i === 0 ? patch(account) : account)),
});

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

// Best-effort persist: a CAS loss to a concurrent rotation or quota write is
// fine because the live state already carries a snapshot at least as fresh
// as the one we'd write. The hot path must not block on the write completing
// or surface its failures to the caller. Skip writing when the response
// carries no rate-limit signal at all — that would erase the prior snapshot
// for no upside.
//
// On Cloudflare Workers the runtime cancels orphan promises the moment the
// response is sent to the client, so a bare fire-and-forget would lose the
// write on the hot path. The `waitUntil` callback (when supplied by the
// gateway) extends the worker's lifetime past the response so the persist
// completes. When `waitUntil` is undefined (Node target / tests / pre-A3
// gateway), the promise still runs to completion under Node's event loop
// — and tests can observe it by awaiting a microtask flush.
const persistQuotaFromHeadersFireAndForget = (
  upstreamId: string,
  headers: Headers,
  waitUntil: ((promise: Promise<unknown>) => void) | undefined,
): void => {
  const snapshot = parseClaudeCodeQuotaHeaders(headers);
  if (Object.keys(snapshot.raw).length === 0) return;
  const persist = persistQuotaSnapshot(upstreamId, snapshot).catch(error => {
    console.warn(`Claude Code: failed to persist quota snapshot for upstream ${upstreamId}: ${String(error)}`);
  });
  waitUntil?.(persist);
};

export const callClaudeCodeMessages = async (
  opts: CallClaudeCodeMessagesOptions,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  // `model.id` is the public alias on the catalog; the dated upstream id
  // Anthropic expects on the wire — and that the pricing table keys by —
  // lives under `providerData.upstreamModelId`. Resolve once so synthetic
  // gates, the wire body, and the streaming-call modelKey all surface the
  // same dated id.
  const providerData = opts.model.providerData as ClaudeCodeProviderData | undefined;
  if (!providerData || typeof providerData.upstreamModelId !== 'string') {
    throw new Error(`Claude Code model ${opts.model.id} is missing providerData.upstreamModelId`);
  }
  const upstreamModelId = providerData.upstreamModelId;

  // recordUpstreamLatency contract: every code path that returns must wrap
  // exactly one fetch (real or synthetic). Synthetic gates ride a resolved
  // promise so the gateway's recorder sees the contract met without
  // measuring anything meaningful. Both the pre-flight gates and the 401-retry
  // terminal-state branch use this helper so the two paths read identically;
  // the recorder's "at least once + last wrap kept" contract is satisfied
  // even when the streaming call already wrapped its own fetch upstream of
  // the retry.
  const syntheticReturn = async (response: Response): Promise<ProviderStreamResult<MessagesStreamEvent>> => ({
    ok: false,
    modelKey: upstreamModelId,
    response: await opts.call.recordUpstreamLatency(Promise.resolve(response)),
  });

  // Either ensures a usable access token or returns a 503 wrap for terminal
  // refresh failures; other errors propagate. Used at both the cold-start
  // call site and the 401-retry branch so the catch shape lives in one place.
  const ensureOrSession503 = async (): Promise<EnsuredAccessToken | ProviderStreamResult<MessagesStreamEvent>> => {
    try {
      return await ensureClaudeCodeAccessToken({
        upstreamId: opts.upstreamId,
        repo: getProviderRepo().upstreams,
        fetcher: opts.call.fetcher,
      });
    } catch (err) {
      if (err instanceof ClaudeCodeOAuthSessionTerminatedError) {
        // ensureClaudeCodeAccessToken already persisted the terminal state.
        return await syntheticReturn(synthetic503(`Claude Code refresh failed: ${err.upstreamMessage}`));
      }
      throw err;
    }
  };

  const fresh = await getProviderRepo().upstreams.getById(opts.upstreamId);
  if (!fresh) throw new Error(`Claude Code upstream ${opts.upstreamId} disappeared mid-request`);
  const state = readClaudeCodeUpstreamState(fresh.state);
  const account = state.accounts[0];

  if (account.state !== 'active') {
    return await syntheticReturn(synthetic503(
      `Claude Code account is ${account.state}: ${account.stateMessage}`,
    ));
  }

  const now = new Date();
  const quotaData = account.quotaSnapshot === null ? null : account.quotaSnapshot.data;
  if (isRateLimitedNow(quotaData, now)) {
    const resetIso = quotaData.reset;
    return await syntheticReturn(synthetic429(
      resetIso ? `Claude Code upstream rate-limited until ${resetIso}` : 'Claude Code upstream rate-limited',
      resetIso,
      now,
    ));
  }

  const ensured = await ensureOrSession503();
  if ('modelKey' in ensured) return ensured;

  return await performUpstreamCall(opts, upstreamModelId, ensured, false, syntheticReturn, ensureOrSession503);
};

const performUpstreamCall = async (
  opts: CallClaudeCodeMessagesOptions,
  upstreamModelId: string,
  accessToken: EnsuredAccessToken,
  alreadyRetried: boolean,
  syntheticReturn: (response: Response) => Promise<ProviderStreamResult<MessagesStreamEvent>>,
  ensureOrSession503: () => Promise<EnsuredAccessToken | ProviderStreamResult<MessagesStreamEvent>>,
): Promise<ProviderStreamResult<MessagesStreamEvent>> => {
  let headers: Record<string, string>;
  if (opts.shaped) {
    // Drop any inbound authorization before setting ours.
    // `clientRequestHeaders` is typed lowercase-only (`UpstreamCallOptions`
    // JSDoc + `headersToRecord` guarantee), so a single lowercase delete is
    // sufficient.
    const passthrough: Record<string, string> = { ...opts.headers };
    delete passthrough.authorization;
    headers = { ...passthrough, authorization: `Bearer ${accessToken.entry.token}` };
  } else {
    headers = { ...pickClaudeCodeHeaders(upstreamModelId), 'Content-Type': 'application/json', authorization: `Bearer ${accessToken.entry.token}` };
  }

  // Force stream:true regardless of caller intent. The streaming envelope is
  // what the gateway boundary expects; non-streaming Messages is routed
  // elsewhere. Safe in the shaped passthrough path too: shaped detection
  // requires CC client headers + system blocks + a valid metadata.user_id,
  // and the real Claude Code client always sets `stream: true`.
  const wireBody: MessagesPayload = { ...opts.body, model: upstreamModelId, stream: true };

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
      // `opts.call.waitUntil` is added by the gateway on Workers so the
      // runtime keeps the worker alive past the response (without it, the
      // persist promise gets cancelled the moment we return the response).
      // The cast is a transitional shim until UpstreamCallOptions carries
      // the field natively; the `?.` keeps the call safe under hosts that
      // don't supply it (Node target / tests).
      const waitUntil = (opts.call as UpstreamCallOptions & { waitUntil?: (promise: Promise<unknown>) => void }).waitUntil;
      persistQuotaFromHeadersFireAndForget(opts.upstreamId, response.headers, waitUntil);
    }
    return response;
  });

  const result = await streamingProviderCall(upstreamFetch, parseMessagesStream, upstreamModelId, opts.signal);

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
    const ensured = await ensureOrSession503();
    // If the refresh terminated, ensureOrSession503 returns a syntheticReturn
    // wrap. That wrap intentionally shadows the failed first fetch's recorded
    // latency under the "last wrap wins" semantics — the telemetry surface
    // reflects the synthetic 503 because that is what the caller sees, not the
    // 401 we discarded.
    if ('modelKey' in ensured) return ensured;
    return await performUpstreamCall(opts, upstreamModelId, ensured, true, syntheticReturn, ensureOrSession503);
  }

  return result;
};
