import { responsesInterceptors } from './interceptors/index.ts';
import type { ResponsesAttemptResult, ResponsesInterceptor, ResponsesInvocation } from './interceptors/types.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './items/output.ts';
import { rewriteResponsesItemsForCandidate } from './items/rewrite.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './items/store.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { providerStreamResultToExecuteResult, telemetryModelIdentity } from '../shared/attempt-helpers.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchLlmServeFailure, type LlmServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { collectResponsesProtocolEventsToResult } from './events/to-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { type ResponsesPayload, type ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, readUpstreamError, type ExecuteResult, type LlmSourceApi } from '@floway-dev/provider';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';

export interface ResponsesAttemptGenerateArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  // Native HTTP/WS entry passes 'append'; the cross-protocol translation-in
  // path (another protocol's attempt translating into Responses) passes
  // 'none' so the outer source owns snapshot persistence.
  readonly snapshotMode: ResponsesSnapshotMode;
  // Optional invocation-headers inheritance from a source attempt that
  // translated INTO responses. Source-side interceptors write trace headers
  // into the source invocation; passing them in here keeps them on the wire.
  readonly inheritedInvocationHeaders?: Record<string, string>;
}

export interface ResponsesAttemptCompactArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
}

export const responsesAttempt = {
  generate: async (args: ResponsesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, store, candidate, snapshotMode, inheritedInvocationHeaders, sourceApi } = args;
    const invocation: ResponsesInvocation = {
      payload,
      candidate,
      sourceApi,
      store,
      headers: { ...(inheritedInvocationHeaders ?? {}) },
    };
    return await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      // Rewriting stored items happens inside the chain runner so interceptors
      // (server-tool shim, vendor normalizers) can adjust the payload first;
      // the rewrite then resolves item references against the chosen
      // candidate's upstream.
      const rewritten = await rewriteOrRenderFailure(invocation.payload, store, candidate);
      if (!('payload' in rewritten)) return rewritten.failure;

      const inner = await dispatchResponses(rewritten.payload, ctx, store, candidate, sourceApi, invocation.headers);
      if (inner.type !== 'events') return inner;
      return eventResult(
        wrapResponsesOutputForStorage(inner.events, {
          store,
          upstream: candidate.binding.upstream,
          snapshotMode,
          targetApi: candidate.targetApi,
        }),
        inner.modelIdentity,
        inner.performance,
        inner.finalMetadata,
      );
    });
  },

  compact: async (args: ResponsesAttemptCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, store, candidate, sourceApi } = args;
    if (candidate.targetApi !== 'responses') {
      throw new Error(`responsesAttempt.compact requires targetApi='responses', got '${candidate.targetApi}'`);
    }
    const invocation: ResponsesInvocation = { payload, candidate, sourceApi, store, headers: {} };

    const chainResult = await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      const rewritten = await rewriteOrRenderFailure(invocation.payload, store, candidate);
      if (!('payload' in rewritten)) return rewritten.failure;
      return await callResponsesCompactAsExecuteResult(rewritten.payload, ctx, candidate, invocation.headers);
    });

    if (chainResult.type !== 'events') return chainResult;

    const compacted = await collectResponsesProtocolEventsToResult(chainResult.events);
    // Drive storage and snapshot via the same wrapper generate uses; the
    // events here are synthesized from the compaction envelope so the
    // upstream-owned ids it carries persist identically to a native call.
    await drainAsync(wrapResponsesOutputForStorage(syntheticEventsFromResult(compacted), {
      store,
      upstream: candidate.binding.upstream,
      snapshotMode: 'replace',
      targetApi: 'responses',
    }));
    return { type: 'result', result: compacted };
  },
};

const chainInterceptors = (candidate: ProviderCandidate): readonly ResponsesInterceptor[] => [
  ...responsesInterceptors,
  ...(candidate.binding.interceptors?.responses ?? []),
];

type RewriteOutcome =
  | { readonly payload: ResponsesPayload }
  | { readonly failure: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> };

const rewriteOrRenderFailure = async (
  payload: ResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<RewriteOutcome> => {
  try {
    return { payload: await rewriteResponsesItemsForCandidate(payload, store, candidate) };
  } catch (error) {
    const failure = tryCatchLlmServeFailure(error);
    if (failure === null) throw error;
    return { failure: renderResponsesAttemptFailure(failure) };
  }
};

// Minimal in-attempt renderer covering the failure kinds rewrite can produce
// (`item-not-found`). The full Responses failure renderer that also handles
// `model-missing` / `model-unsupported` / `routing-unavailable` lives in the
// serve layer and treats the `endpoint` distinction (`generate` vs
// `compact`); from inside an attempt, only `item-not-found` is reachable.
const renderResponsesAttemptFailure = (failure: LlmServeFailure): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => {
  if (failure.kind === 'item-not-found') {
    return {
      type: 'upstream-error',
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
    };
  }
  // `routing-unavailable` originates in the routing layer (not rewrite);
  // `model-*` is produced by the serve layer. Reaching here is a bug.
  throw new Error(`responsesAttempt cannot render failure kind '${failure.kind}' — rewrite only produces 'item-not-found'.`);
};

const dispatchResponses = async (
  payload: ResponsesPayload,
  ctx: GatewayCtx,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
  sourceApi: LlmSourceApi,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  if (candidate.targetApi === 'responses') {
    const { model: _model, ...body } = payload;
    const providerResult = await candidate.binding.provider.callResponses(
      candidate.binding.upstreamModel,
      body,
      ctx.abortSignal,
      invocationHeaders,
    );
    return await providerStreamResultToExecuteResult(providerResult, candidate);
  }
  if (candidate.targetApi === 'messages') {
    return await traverseTranslation(
      payload,
      p => translateResponsesViaMessages(p, {
        model: candidate.binding.upstreamModel.id,
        fallbackMaxOutputTokens: candidate.binding.upstreamModel.limits.max_output_tokens,
      }),
      translated => messagesAttempt.generate({
        payload: translated, ctx, store, candidate, sourceApi, inheritedInvocationHeaders: invocationHeaders,
      }),
    );
  }
  if (candidate.targetApi === 'chat-completions') {
    return await traverseTranslation(
      payload,
      p => translateResponsesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
      translated => chatCompletionsAttempt.generate({
        payload: translated, ctx, store, candidate, sourceApi, inheritedInvocationHeaders: invocationHeaders,
      }),
    );
  }
  throw new Error(`responsesAttempt: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
};

// `/responses/compact` is non-streaming: the provider returns the compaction
// envelope as a value (Copilot rebuilds it from a `compaction_trigger` turn,
// custom upstreams call native `/responses/compact`), so we synthesize the
// canonical event frames here instead of pretending the result came from an
// SSE body. `model` is positional, `stream` and `store` are gateway-only and
// must not reach the wire — `store` is a snapshot-persistence hint, the
// upstream compact endpoint rejects it.
const callResponsesCompactAsExecuteResult = async (
  payload: ResponsesPayload,
  ctx: GatewayCtx,
  candidate: ProviderCandidate,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const { model: _model, stream: _stream, store: _store, ...body } = payload;
  const providerResult = await candidate.binding.provider.callResponsesCompact(
    candidate.binding.upstreamModel,
    body,
    ctx.abortSignal,
    invocationHeaders,
  );
  if (!providerResult.ok) return await readUpstreamError(providerResult.response);
  return eventResult(
    syntheticEventsFromResult(providerResult.result),
    telemetryModelIdentity(candidate, providerResult.modelKey),
  );
};
