import { responsesInterceptors } from './interceptors/index.ts';
import type { ResponsesAttemptResult, ResponsesInvocation } from './interceptors/types.ts';
import { createStoredResponseId } from './items/format.ts';
import { normalizeAssistantInputText } from './items/normalize-assistant-content.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './items/output.ts';
import { rewriteResponsesItemsForCandidate, type RewrittenResponsesPayload } from './items/rewrite.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './items/store.ts';
import { tokenUsageFromResponsesResult } from './usage.ts';
import { recordPerformanceLatency, requireRecordedDurationMs } from '../../shared/telemetry/performance.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { providerStreamResultToExecuteResult, buildUpstreamCallOptions, telemetryModelIdentity } from '../shared/attempt-helpers.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchChatServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { createUpstreamLatencyRecorder, recordUpstreamHttpFailure, upstreamPerformanceContext } from '../shared/upstream-telemetry.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { collectResponsesProtocolEventsToResult } from '@floway-dev/protocols/responses';
import { type ResponsesPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, readUpstreamApiError, type ExecuteResult, type ProviderResponsesResult, type ResponsesAction } from '@floway-dev/provider';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';

export interface ResponsesAttemptInvokeArgs {
  readonly payload: ResponsesPayload;
  readonly action: ResponsesAction;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly headers: Headers;
  // Cross-protocol translation paths (Messages/Gemini/ChatCompletions
  // translating into Responses) own snapshot persistence at the outer
  // protocol's attempt and pass `'none'` so the inner Responses call does
  // not double-write. Native Responses HTTP leaves this absent so the
  // attempt derives snapshot mode from the post-chain action +
  // `payload.store` (compact → 'replace'; generate with store=false →
  // 'none'; generate otherwise → 'append'). WS passes 'append' explicitly
  // so in-session snapshots survive even when the caller opted out of
  // durable storage.
  readonly snapshotMode?: ResponsesSnapshotMode;
}

// Single entry point for both `action: 'generate'` and `action: 'compact'`.
// The interceptor chain owns the action through `invocation.action` and may
// flip it; post-chain we read `invocation.action` to pick snapshot mode
// ('replace' for compact, 'append'/'none' for generate) and decide whether
// to drain the event stream into a single compaction envelope.
export const responsesAttempt = {
  invoke: async (args: ResponsesAttemptInvokeArgs): Promise<ResponsesAttemptResult> => {
    const { payload, action, ctx, store, candidate, headers, snapshotMode: snapshotModeOverride } = args;
    // Read the caller's intent `action` (NOT `invocation.action`) — the guard
    // runs pre-chain, before any interceptor can flip the value.
    if (action === 'compact' && candidate.targetApi !== 'responses') {
      throw new Error(`responsesAttempt.invoke(action='compact') requires targetApi='responses', got '${candidate.targetApi}'`);
    }
    // Compact always replaces history wholesale; an override would be a
    // contract violation. Only `serve.compact` reaches this branch today
    // and it never passes one, but pin the invariant so a future caller
    // that does pass one fails loudly instead of silently overwriting.
    if (action === 'compact' && snapshotModeOverride !== undefined) {
      throw new Error('responsesAttempt.invoke: snapshotMode override is not supported in the compact branch — compact always replaces');
    }
    // Rewrite + privatePayload seed + assistant-content normalization all run
    // BEFORE the interceptor chain so source interceptors — most importantly
    // the web-search server-tool shim — see fully inline-expanded input items
    // with their original wire ids, and `store.getPrivatePayload(id)` is
    // ready to hand back the persisted IR. The shim's `transformItems` runs
    // inside the chain body, before `run()`, so deferring rewrite/seed to
    // the inner closure would leave the shim looking at the pre-rewrite
    // wire shape against an empty privatePayload map.
    const rewritten = await rewriteOrRenderFailure(payload, store, candidate);
    if (!('payload' in rewritten)) return rewritten.failure;
    store.beginAttempt(rewritten.references);
    // Copilot compaction and Azure-native compaction both emit assistant
    // messages whose content blocks have `type: 'input_text'`, then refuse
    // the same items echoed back as input on the next turn. Normalising
    // here, after the rewrite has expanded any `item_reference` items
    // from the snapshot store, catches both the direct-echo and
    // store-replay paths in one place.
    const normalized: ResponsesPayload = { ...rewritten.payload, input: normalizeAssistantInputText(rewritten.payload.input) };

    const invocation: ResponsesInvocation = {
      payload: normalized,
      action,
      candidate,
      store,
      headers,
    };
    const chainResult = await runInterceptors(invocation, ctx, responsesInterceptors, async () =>
      await dispatchResponses(invocation, ctx));

    if (chainResult.type !== 'events') return chainResult;

    // Snapshot mode reads the post-chain action on the invocation: an
    // interceptor that pivots 'compact'→'generate' (or vice versa) steers
    // storage end-to-end. A generate request carrying a `compaction_trigger`
    // input item produces a compaction-shape envelope at the upstream and
    // must also snapshot=replace.
    const responseId = createStoredResponseId();
    if (invocation.action === 'compact') {
      // Drain the events into a single envelope and return the value branch
      // so the http compact endpoint can JSON-encode it directly. Storage
      // still runs over the synthesized event stream so the snapshot is
      // committed under the same id the client will see.
      const upstreamCompacted = await collectResponsesProtocolEventsToResult(chainResult.events);
      await drainAsync(wrapResponsesOutputForStorage(syntheticEventsFromResult(upstreamCompacted), {
        store,
        upstream: candidate.binding.upstream,
        snapshotMode: 'replace',
        targetApi: 'responses',
        responseId,
      }));
      return {
        type: 'result',
        result: { ...upstreamCompacted, id: responseId },
        modelIdentity: chainResult.modelIdentity,
        usage: tokenUsageFromResponsesResult(upstreamCompacted),
      };
    }

    // The base mode comes from the caller's override (WS pins 'append',
    // cross-protocol translation pins 'none') or, when absent (native HTTP),
    // is derived from `payload.store`. A `compaction_trigger` in the input
    // then upgrades the base to 'replace' — except when the base is 'none',
    // which the translation-in path uses to opt out of inner persistence.
    const baseSnapshotMode: ResponsesSnapshotMode = snapshotModeOverride
      ?? (normalized.store === false ? 'none' : 'append');
    const snapshotMode: ResponsesSnapshotMode = baseSnapshotMode !== 'none' && containsCompactionTrigger(normalized.input)
      ? 'replace'
      : baseSnapshotMode;
    // Persistence and id rewriting wrap the *outermost* stream — after every
    // interceptor (including the server-tool shim) has emitted its final
    // events. This is the only seam at which the gateway-owned response id
    // is minted; whatever id any inner layer produced (the upstream's blob,
    // the shim's internal `resp_shim_*` placeholder) is overwritten to a
    // `resp_<crc>_<body>` before the client sees a frame, and the snapshot
    // is committed under the same id so the next turn's
    // `previous_response_id` lookup is guaranteed to hit.
    return eventResult(
      wrapResponsesOutputForStorage(chainResult.events, {
        store,
        upstream: candidate.binding.upstream,
        snapshotMode,
        targetApi: candidate.targetApi,
        responseId,
      }),
      chainResult.modelIdentity,
      {
        performance: chainResult.performance,
        finalMetadata: chainResult.finalMetadata,
        headers: chainResult.headers,
      },
    );
  },

  // Narrowing wrapper for cross-protocol translation callers
  // (Messages/Gemini/ChatCompletions translating into Responses) and the
  // native HTTP/WS generate entry — both always run in generate mode and
  // want the ExecuteResult branch. The compact branch is a contract
  // violation here; an interceptor that pivoted generate→compact would
  // surface as a throw, not a silent shape mismatch.
  generate: async (args: Omit<ResponsesAttemptInvokeArgs, 'action'>): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const result = await responsesAttempt.invoke({ ...args, action: 'generate' });
    if (result.type === 'result') {
      throw new Error('responsesAttempt.generate received a compact result; an interceptor pivoted generate→compact unexpectedly');
    }
    return result;
  },
};

// Codex's RemoteCompactionV2 performs compaction through the generate path
// by appending a `compaction_trigger` control item to the input. Semantically
// this is the same operation as `/responses/compact`: the upstream replaces
// the prior history with a single `compaction` output, and any later
// `previous_response_id` should resolve to that blob alone — not the dropped
// history. Treat such a request like compact at the snapshot seam even when
// the action stays 'generate' (the codex provider's compact branch goes
// through action='compact', but a direct generate carrying the trigger
// reaches the same upstream behavior).
const containsCompactionTrigger = (input: ResponsesPayload['input']): boolean =>
  typeof input !== 'string' && input.some(item => item.type === 'compaction_trigger');

type RewriteOutcome =
  | RewrittenResponsesPayload
  | { readonly failure: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> };

const rewriteOrRenderFailure = async (
  payload: ResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<RewriteOutcome> => {
  try {
    return await rewriteResponsesItemsForCandidate(payload, store, candidate);
  } catch (error) {
    const failure = tryCatchChatServeFailure(error);
    if (failure === null) throw error;
    // The full Responses failure renderer that also handles `model-missing`
    // / `model-unsupported` / `routing-unavailable` lives in the serve
    // layer and treats the `endpoint` distinction (`generate` vs
    // `compact`); from inside an attempt, only `item-not-found` is
    // reachable from rewrite — anything else is a bug. Re-throw the
    // original error so the upstream stack/cause survives.
    if (failure.kind !== 'item-not-found') throw error;
    return {
      failure: {
        type: 'api-error',
        source: 'gateway',
        status: 404,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          error: {
            message: `Item with id '${failure.itemId}' not found.`,
            type: 'invalid_request_error',
            param: 'input',
            code: null,
          },
        })),
      },
    };
  }
};

const dispatchResponses = async (
  invocation: ResponsesInvocation,
  ctx: GatewayCtx,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const { candidate, store } = invocation;
  switch (candidate.targetApi) {
  case 'responses': {
    const recorder = createUpstreamLatencyRecorder();
    if (invocation.action === 'compact') {
      // The compact wire body drops `stream` and `store` — `store` is a
      // gateway-only snapshot-persistence hint that the upstream compact
      // endpoint rejects, and `stream` is irrelevant on a non-streaming
      // call. The generate branch leaves both fields on the body so the
      // provider can decide for itself (every provider's streaming call
      // forces stream=true anyway).
      const { model: _model, stream: _stream, store: _store, ...body } = invocation.payload;
      const providerResult = await candidate.binding.provider.callResponses(
        candidate.binding.upstreamModel,
        body,
        invocation.action,
        ctx.abortSignal,
        buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
      );
      return await providerResponsesResultToExecuteResult(providerResult, candidate, ctx, recorder);
    }
    const { model: _model, ...body } = invocation.payload;
    const providerResult = await candidate.binding.provider.callResponses(
      candidate.binding.upstreamModel,
      body,
      invocation.action,
      ctx.abortSignal,
      buildUpstreamCallOptions(candidate, ctx, recorder.record, invocation.headers),
    );
    return await providerResponsesResultToExecuteResult(providerResult, candidate, ctx, recorder);
  }
  case 'messages':
    if (invocation.action === 'compact') {
      throw new Error(`responsesAttempt: action='compact' is unreachable on targetApi='messages' (filtered by serve-prep)`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateResponsesViaMessages(p, {
        model: candidate.binding.upstreamModel.id,
        fallbackMaxOutputTokens: candidate.binding.upstreamModel.limits.max_output_tokens,
      }),
      translated => messagesAttempt.generate({
        payload: translated, ctx, store, candidate, headers: invocation.headers,
      }),
    );
  case 'chat-completions':
    if (invocation.action === 'compact') {
      throw new Error(`responsesAttempt: action='compact' is unreachable on targetApi='chat-completions' (filtered by serve-prep)`);
    }
    return await traverseTranslation(
      invocation.payload,
      p => translateResponsesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
      translated => chatCompletionsAttempt.generate({
        payload: translated, ctx, store, candidate, headers: invocation.headers,
      }),
    );
  default: {
    const exhaustive: never = candidate.targetApi;
    throw new Error(`unexpected targetApi '${exhaustive as string}'`);
  }
  }
};

// Lowers a `ProviderResponsesResult` into the chain's
// ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> currency. The compact
// branch synthesizes SSE frames from the envelope so every downstream
// interceptor sees the same event-stream contract regardless of which action
// the provider executed.
const providerResponsesResultToExecuteResult = async (
  providerResult: ProviderResponsesResult,
  candidate: ProviderCandidate,
  ctx: GatewayCtx,
  recorder: ReturnType<typeof createUpstreamLatencyRecorder>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  if (providerResult.action === 'generate') {
    return await providerStreamResultToExecuteResult(
      providerResult.ok
        ? { ok: true, events: providerResult.events, modelKey: providerResult.modelKey, ...(providerResult.headers ? { headers: providerResult.headers } : {}) }
        : { ok: false, response: providerResult.response, modelKey: providerResult.modelKey },
      candidate,
      ctx,
      recorder,
    );
  }
  // action === 'compact'. The non-streaming envelope expands into the same
  // event stream wrap-output-storage consumes for the streaming path.
  const context = upstreamPerformanceContext(ctx, candidate, providerResult.modelKey);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(ctx, context);
    return { ...(await readUpstreamApiError(providerResult.response, candidate.binding.upstream)), performance: context };
  }
  ctx.backgroundScheduler(recordPerformanceLatency(context, 'upstream_success', requireRecordedDurationMs(recorder, 'callResponses(action=compact)')));
  return eventResult(
    syntheticEventsFromResult(providerResult.result),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context },
  );
};
