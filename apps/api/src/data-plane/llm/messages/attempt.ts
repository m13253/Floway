import { messagesInterceptors, messagesCountTokensInterceptors } from './interceptors/index.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor, MessagesInvocation } from './interceptors/types.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import { rewriteStoredResponsesItemsForCandidate } from '../responses/items/rewrite.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import { tryCatchLlmServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { plainResultFromResponse } from '../shared/respond.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesMessage, MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, readUpstreamError, type ExecuteResult, type LlmSourceApi, type PlainResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface MessagesAttemptGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  readonly anthropicBeta?: readonly string[];
}

export interface MessagesAttemptCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly sourceApi: LlmSourceApi;
  readonly anthropicBeta?: readonly string[];
}

export const messagesAttempt = {
  generate: async (args: MessagesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, candidate, sourceApi, anthropicBeta } = args;
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) return rewritten.failure;
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      sourceApi,
      ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      headers: {},
    };
    return await runInterceptors(invocation, ctx, sourceChainInterceptors(candidate), async () => {
      if (candidate.targetApi === 'messages') {
        // Target-side Messages interceptors (anthropic-beta filter, vision
        // header, tool-strict stripper for Copilot Vertex, etc.) only apply
        // when the wire actually carries a Messages payload — running them
        // for translated targets would mutate fields the translator hasn't
        // produced yet (or shouldn't strip from the translation source).
        return await runInterceptors(invocation, ctx, targetChainInterceptors(candidate), () =>
          callMessagesAsExecuteResult(invocation.payload, ctx, candidate, invocation.anthropicBeta, invocation.headers));
      }
      if (candidate.targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaResponses(p, { model: candidate.binding.upstreamModel.id }),
          translated => responsesAttempt.generate({
            payload: translated, ctx, store, candidate, sourceApi, snapshotMode: 'none', inheritedInvocationHeaders: invocation.headers,
          }),
        );
      }
      if (candidate.targetApi === 'chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
          translated => chatCompletionsAttempt.generate({
            payload: translated, ctx, store, candidate, sourceApi, inheritedInvocationHeaders: invocation.headers,
          }),
        );
      }
      throw new Error(`messagesAttempt.generate: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
    });
  },

  countTokens: async (args: MessagesAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload, ctx, store, candidate, sourceApi, anthropicBeta } = args;
    if (candidate.targetApi !== 'messages') {
      throw new Error(`messagesAttempt.countTokens requires targetApi='messages', got '${candidate.targetApi}'`);
    }
    const rewritten = await rewriteOrRenderMessagesFailure(payload, store, candidate);
    if (rewritten.failure) {
      // count_tokens has no streaming envelope; surface the rewrite-time
      // failure as a synthetic PlainResult carrying the same body.
      return { type: 'plain', status: rewritten.failure.status, headers: rewritten.failure.headers, body: rewritten.failure.body };
    }
    const invocation: MessagesInvocation = {
      payload: rewritten.payload,
      candidate,
      sourceApi,
      ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      headers: {},
    };
    const response = await runInterceptors(invocation, ctx, countTokensChainInterceptors(candidate), async () => {
      const { model: _model, ...body } = invocation.payload;
      const { response } = await candidate.binding.provider.callMessagesCountTokens(
        candidate.binding.upstreamModel,
        body,
        ctx.abortSignal,
        mergeInvocationHeaders(ctx.headers, invocation.headers),
        invocation.anthropicBeta,
      );
      return response;
    });
    return await plainResultFromResponse(response);
  },
};

// Rewrites stored Responses item carriers (assistant thinking blocks whose
// signature packs a gateway-stored reasoning id) to the upstream-owned id
// the chosen candidate's wire requires. Failures only originate from
// `item_reference` against a candidate without item_reference support, which
// the affinity walk already excluded — but defensive rewrite is cheap and
// keeps the attempt closed-loop.
const rewriteOrRenderMessagesFailure = async (
  payload: MessagesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<{ payload: MessagesPayload; failure?: undefined } | { payload?: undefined; failure: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> & { type: 'upstream-error' } }> => {
  try {
    const rewrittenMessages = await rewriteStoredResponsesItemsForCandidate(
      payload.messages as readonly MessagesMessage[],
      messagesViaResponsesItemsView,
      store,
      candidate,
    );
    return { payload: { ...payload, messages: rewrittenMessages as MessagesMessage[] } };
  } catch (error) {
    const failure = tryCatchLlmServeFailure(error);
    if (failure === null) throw error;
    if (failure.kind !== 'item-not-found') throw error;
    return {
      failure: {
        type: 'upstream-error',
        status: 400,
        headers: new Headers({ 'content-type': 'application/json' }),
        body: new TextEncoder().encode(JSON.stringify({
          type: 'error',
          error: { type: 'invalid_request_error', message: `Item with id '${failure.itemId}' not found.` },
        })),
      },
    };
  }
};

// Source-side interceptors apply regardless of target — they shape the
// Messages payload before either calling Messages directly or translating to
// another protocol. Target-side interceptors only apply when the wire
// actually carries Messages: they run as an inner chain inside the
// targetApi==='messages' branch.
const sourceChainInterceptors = (candidate: ProviderCandidate): readonly MessagesInterceptor[] => [
  ...messagesInterceptors,
  ...(candidate.binding.interceptors?.messages ?? []),
];

const targetChainInterceptors = (candidate: ProviderCandidate): readonly MessagesInterceptor[] =>
  candidate.binding.interceptors?.messagesTarget ?? [];

const countTokensChainInterceptors = (candidate: ProviderCandidate): readonly MessagesCountTokensInterceptor[] => [
  ...messagesCountTokensInterceptors,
  ...(candidate.binding.interceptors?.messagesCountTokens ?? []),
];

const callMessagesAsExecuteResult = async (
  payload: MessagesPayload,
  ctx: GatewayCtx,
  candidate: ProviderCandidate,
  anthropicBeta: readonly string[] | undefined,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
  const { model: _model, ...body } = payload;
  const providerResult = await candidate.binding.provider.callMessages(
    candidate.binding.upstreamModel,
    body,
    ctx.abortSignal,
    mergeInvocationHeaders(ctx.headers, invocationHeaders),
    anthropicBeta,
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

// `ctx.headers` is the shared Headers bag every protocol crosses; the per-
// invocation `Record<string, string>` is where provider-side interceptors
// still write. Merge with invocation-set values winning so a provider
// interceptor can override a header the ctx already carried.
const mergeInvocationHeaders = (ctxHeaders: Headers, invocationHeaders: Record<string, string>): Record<string, string> => {
  const merged: Record<string, string> = {};
  ctxHeaders.forEach((value, key) => {
    merged[key] = value;
  });
  for (const [key, value] of Object.entries(invocationHeaders)) merged[key] = value;
  return merged;
};
