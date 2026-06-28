import { chatCompletionsAttempt } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import { enumerateProviderCandidates } from '../../providers/candidates.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { planChatCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ModelEndpoints, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

const pickChatCompletionsTarget = (endpoints: ModelEndpoints): ChatTargetApi | null =>
  endpoints.chatCompletions ? 'chat-completions'
    : endpoints.messages ? 'messages'
      : endpoints.responses ? 'responses'
        : null;

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const planItems = planChatCandidates(candidates, pickChatCompletionsTarget);
    const decision = await planChatCompletionsRouting({ payload, candidates: planItems, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [item] = decision.candidates;
    if (item === undefined) {
      return renderChatCompletionsFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
      );
    }
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate: item.candidate, targetApi: item.targetApi, headers });
  },
};
