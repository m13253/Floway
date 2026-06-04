import { messagesInterceptors, messagesCountTokensInterceptors } from './interceptors/index.ts';
import type { MessagesCountTokensInterceptor, MessagesInterceptor, MessagesInvocation } from './interceptors/types.ts';
import { chatCompletionsAttempt } from '../chat-completions/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { plainResultFromResponse } from '../sources/respond.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import { eventResult, readUpstreamError, type ExecuteResult, type PlainResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateMessagesViaChatCompletions, translateMessagesViaResponses } from '@floway-dev/translate';

export interface MessagesAttemptGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
}

export interface MessagesAttemptCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
}

export const messagesAttempt = {
  generate: async (args: MessagesAttemptGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, candidate, anthropicBeta } = args;
    const invocation: MessagesInvocation = {
      payload,
      candidate,
      ...(anthropicBeta !== undefined ? { anthropicBeta } : {}),
      headers: {},
    };
    return await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      if (candidate.targetApi === 'messages') {
        return await callMessagesAsExecuteResult(invocation.payload, ctx, candidate, invocation.anthropicBeta, invocation.headers);
      }
      if (candidate.targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaResponses(p, { model: candidate.binding.upstreamModel.id }),
          translated => responsesAttempt.generate({
            payload: translated, ctx, store, candidate, snapshotMode: 'none',
          }),
        );
      }
      if (candidate.targetApi === 'chat-completions') {
        return await traverseTranslation(
          invocation.payload,
          p => translateMessagesViaChatCompletions(p, { model: candidate.binding.upstreamModel.id }),
          translated => chatCompletionsAttempt.generate({
            payload: translated, ctx, store, candidate,
          }),
        );
      }
      throw new Error(`messagesAttempt.generate: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
    });
  },

  countTokens: async (args: MessagesAttemptCountTokensArgs): Promise<PlainResult> => {
    const { payload, ctx, candidate, anthropicBeta } = args;
    if (candidate.targetApi !== 'messages') {
      throw new Error(`messagesAttempt.countTokens requires targetApi='messages', got '${candidate.targetApi}'`);
    }
    const invocation: MessagesInvocation = {
      payload,
      candidate,
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

// Provider-side `interceptors.messages` / `interceptors.messagesCountTokens`
// are still typed against the wide pre-redesign `Invocation`. The runtime
// instances satisfy the slim shape (they only read `candidate.binding` fields
// the wide shape also carries) and write into `invocation.headers`; cast at
// the join until the provider-package migration lands.
const chainInterceptors = (candidate: ProviderCandidate): readonly MessagesInterceptor[] => [
  ...messagesInterceptors,
  ...((candidate.binding.interceptors?.messages ?? []) as readonly unknown[] as readonly MessagesInterceptor[]),
];

const countTokensChainInterceptors = (candidate: ProviderCandidate): readonly MessagesCountTokensInterceptor[] => [
  ...messagesCountTokensInterceptors,
  ...((candidate.binding.interceptors?.messagesCountTokens ?? []) as readonly unknown[] as readonly MessagesCountTokensInterceptor[]),
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
