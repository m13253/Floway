import { responsesInterceptors } from './interceptors/index.ts';
import type { ResponsesAttemptResult, ResponsesInterceptor, ResponsesInvocation } from './interceptors/types.ts';
import { drainAsync, syntheticEventsFromResult, wrapResponsesOutputForStorage } from './items/output.ts';
import { rewriteResponsesItemsForCandidate } from './items/rewrite.ts';
import type { ResponsesSnapshotMode, StatefulResponsesStore } from './items/store.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchLlmServeFailure, type LlmServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { collectResponsesProtocolEventsToResult } from './events/to-result.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import { eventResult, readUpstreamError, type ExecuteResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';
import { compactionResponse } from '@floway-dev/provider-copilot/compaction';
import { translateResponsesViaChatCompletions, translateResponsesViaMessages } from '@floway-dev/translate';

export interface ResponsesAttemptGenerateArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  // Native HTTP/WS entry passes 'append'; the cross-protocol translation-in
  // path (another protocol's attempt translating into Responses) passes
  // 'none' so the outer source owns snapshot persistence.
  readonly snapshotMode: ResponsesSnapshotMode;
}

export interface ResponsesAttemptCompactArgs {
  readonly payload: ResponsesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
}

export const responsesAttempt = {
  generate: async (args: ResponsesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, store, candidate, snapshotMode } = args;
    const invocation: ResponsesInvocation = { payload, candidate, store, headers: {} };
    return await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      // Rewrite runs inside the chain runner so an interceptor can mutate
      // the payload (server-tool shim, vendor normalizers) before stored
      // items are resolved against the chosen candidate.
      const rewritten = await rewriteOrRenderFailure(invocation.payload, store, candidate);
      if (!('payload' in rewritten)) return rewritten.failure;

      const inner = await dispatchResponses(rewritten.payload, ctx, store, candidate, invocation.headers);
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
    const { payload, ctx, store, candidate } = args;
    if (candidate.targetApi !== 'responses') {
      throw new Error(`responsesAttempt.compact requires targetApi='responses', got '${candidate.targetApi}'`);
    }
    const invocation: ResponsesInvocation = { payload, candidate, store, headers: {} };

    // Capture the rewritten input from the chain's last invocation so the
    // post-chain compaction reshape sees the same items the upstream did.
    // Retry interceptors may invoke `run` multiple times; the latest call
    // wins, matching the events the chain actually emitted.
    let rewrittenInput: ResponsesInputItem[] | null = null;

    const chainResult = await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      const rewritten = await rewriteOrRenderFailure(invocation.payload, store, candidate);
      if (!('payload' in rewritten)) return rewritten.failure;
      rewrittenInput = inputAsItems(rewritten.payload.input);
      return await callResponsesAsExecuteResult(rewritten.payload, ctx, candidate, invocation.headers);
    });

    if (chainResult.type !== 'events') return chainResult;
    if (rewrittenInput === null) {
      throw new Error('responsesAttempt.compact: chain returned events without invoking the provider call');
    }

    const generated = await collectResponsesProtocolEventsToResult(chainResult.events);
    const compacted = compactionResponse(rewrittenInput, generated);
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

// Provider-side `interceptors.responses` is still typed against the wide
// pre-redesign `Invocation`. The runtime instances satisfy the slim shape
// (they only read `candidate.binding` fields the wide shape also carries),
// and the provider-package migration to the slim type is later in this
// refactor. Until then, cast at the join.
const chainInterceptors = (candidate: ProviderCandidate): readonly ResponsesInterceptor[] => [
  ...responsesInterceptors,
  ...((candidate.binding.interceptors?.responses ?? []) as readonly unknown[] as readonly ResponsesInterceptor[]),
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
    return jsonUpstreamErrorResult(404, {
      error: {
        message: `Item with id '${failure.itemId}' not found.`,
        type: 'invalid_request_error',
        param: 'input',
        code: null,
      },
    });
  }
  // `routing-unavailable` originates in the routing layer (not rewrite);
  // `model-*` is produced by the serve layer. Reaching here is a bug.
  throw new Error(`responsesAttempt cannot render failure kind '${failure.kind}' — rewrite only produces 'item-not-found'.`);
};

const jsonUpstreamErrorResult = (status: number, body: unknown): ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
});

const dispatchResponses = async (
  payload: ResponsesPayload,
  ctx: GatewayCtx,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  if (candidate.targetApi === 'responses') {
    return await callResponsesAsExecuteResult(payload, ctx, candidate, invocationHeaders);
  }
  if (candidate.targetApi === 'messages') {
    return await traverseTranslation(
      payload,
      p => translateResponsesViaMessages(p, {
        model: candidate.binding.upstreamModel.id,
        fallbackMaxOutputTokens: candidate.binding.upstreamModel.limits.max_output_tokens,
      }),
      translated => messagesAttempt.generate({ payload: translated, ctx, store, candidate }),
    );
  }
  if (candidate.targetApi === 'chat-completions') {
    return await traverseTranslation(
      payload,
      p => translateResponsesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
      translated => chatCompletionsAttempt.generate({ payload: translated, ctx, store, candidate }),
    );
  }
  throw new Error(`responsesAttempt: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
};

const callResponsesAsExecuteResult = async (
  payload: ResponsesPayload,
  ctx: GatewayCtx,
  candidate: ProviderCandidate,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
  const { model: _model, ...body } = payload;
  const providerResult = await candidate.binding.provider.callResponses(
    candidate.binding.upstreamModel,
    body,
    ctx.abortSignal,
    mergeInvocationHeaders(ctx.headers, invocationHeaders),
  );
  return await providerStreamResultToExecuteResult(providerResult, candidate);
};

const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ProviderCandidate,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  if (!providerResult.ok) return await readUpstreamError(providerResult.response);
  return eventResult(
    providerResult.events as AsyncIterable<ProtocolFrame<TEvent>>,
    telemetryModelIdentity(candidate, providerResult.modelKey),
  );
};

const telemetryModelIdentity = (candidate: ProviderCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.binding.upstreamModel.id,
  upstream: candidate.binding.upstream,
  modelKey,
  cost: candidate.binding.provider.getPricingForModelKey(modelKey),
});

const headersToRecord = (headers: Headers): Record<string, string> => {
  const record: Record<string, string> = {};
  headers.forEach((value, key) => {
    record[key] = value;
  });
  return record;
};

// `ctx.headers` is the shared Headers bag every protocol crosses; the per-
// invocation `Record<string, string>` is where provider-side interceptors
// still write. Merge with invocation-set values winning so a provider
// interceptor can override a header the ctx already carried.
const mergeInvocationHeaders = (ctxHeaders: Headers, invocationHeaders: Record<string, string>): Record<string, string> => {
  const merged = headersToRecord(ctxHeaders);
  for (const [key, value] of Object.entries(invocationHeaders)) merged[key] = value;
  return merged;
};

const inputAsItems = (input: ResponsesPayload['input']): ResponsesInputItem[] =>
  typeof input === 'string' ? [{ type: 'message', role: 'user', content: input }] : [...input];
