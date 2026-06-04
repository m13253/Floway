import { chatCompletionsInterceptors } from './interceptors/index.ts';
import type { ChatCompletionsInterceptor, ChatCompletionsInvocation } from './interceptors/types.ts';
import { messagesAttempt } from '../messages/attempt.ts';
import { responsesAttempt } from '../responses/attempt.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { traverseTranslation } from '../shared/translate-traverse.ts';
import { runInterceptors } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamError, type ExecuteResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';
import { translateChatCompletionsViaMessages, translateChatCompletionsViaResponses } from '@floway-dev/translate';

export interface ChatCompletionsAttemptArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
}

export const chatCompletionsAttempt = {
  generate: async (args: ChatCompletionsAttemptArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store, candidate } = args;
    const invocation: ChatCompletionsInvocation = { payload, candidate, headers: {} };
    return await runInterceptors(invocation, ctx, chainInterceptors(candidate), async () => {
      if (candidate.targetApi === 'chat-completions') {
        return await callChatCompletionsAsExecuteResult(invocation.payload, ctx, candidate, invocation.headers);
      }
      if (candidate.targetApi === 'messages') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaMessages(p, {
            model: candidate.binding.upstreamModel.id,
            fallbackMaxOutputTokens: candidate.binding.upstreamModel.limits.max_output_tokens,
          }),
          translated => messagesAttempt.generate({ payload: translated, ctx, store, candidate }),
        );
      }
      if (candidate.targetApi === 'responses') {
        return await traverseTranslation(
          invocation.payload,
          p => translateChatCompletionsViaResponses(p, { model: candidate.binding.upstreamModel.id }),
          translated => responsesAttempt.generate({ payload: translated, ctx, store, candidate, snapshotMode: 'none' }),
        );
      }
      throw new Error(`chatCompletionsAttempt.generate: unexpected targetApi '${(candidate as { targetApi: string }).targetApi}'`);
    });
  },
};

// Provider-side `interceptors.chatCompletions` is still typed against the
// wide pre-redesign `Invocation`. The runtime instances satisfy the slim
// shape (they only read `candidate.binding` fields the wide shape also
// carries) and write into `invocation.headers`; cast at the join until the
// provider-package migration lands.
const chainInterceptors = (candidate: ProviderCandidate): readonly ChatCompletionsInterceptor[] => [
  ...chatCompletionsInterceptors,
  ...((candidate.binding.interceptors?.chatCompletions ?? []) as readonly unknown[] as readonly ChatCompletionsInterceptor[]),
];

const callChatCompletionsAsExecuteResult = async (
  payload: ChatCompletionsPayload,
  ctx: GatewayCtx,
  candidate: ProviderCandidate,
  invocationHeaders: Record<string, string>,
): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
  const { model: _model, ...body } = payload;
  const providerResult = await candidate.binding.provider.callChatCompletions(
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
