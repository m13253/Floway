import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { narrowChatCompletionsByItemAffinity } from './narrow.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

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
    const decision = await narrowChatCompletionsByItemAffinity({ payload, candidates: viable, ctx });
    if (isChatServeFailure(decision)) return renderChatCompletionsFailure(decision);

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision;
    if (candidate === undefined) {
      return renderChatCompletionsFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
      );
    }
    return await chatCompletionsAttempt.generate({ payload, ctx, candidate, headers });
  },
};
