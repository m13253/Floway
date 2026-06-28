import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { isAttemptSuccess, isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = candidates.filter(c => chatCompletionsTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: chatCompletionsViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (isChatServeFailure(decision)) return renderChatCompletionsFailure(decision);
    if (decision.length === 0) {
      return renderChatCompletionsFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
      );
    }

    let lastFailure: ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>> | undefined;
    for (const candidate of decision) {
      const result = await chatCompletionsAttempt.generate({ payload, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },
};
