import { chatCompletionsAttempt } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store } = args;
    const candidates = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: payload.model,
      sourceApi: 'chat-completions',
      pickTarget: endpoints =>
        endpoints.chatCompletions ? 'chat-completions'
          : endpoints.messages ? 'messages'
            : endpoints.responses ? 'responses'
              : null,
    });
    const decision = await planChatCompletionsRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    let sawAny = false;
    for (const candidate of decision.candidates) {
      sawAny = true;
      const result = await chatCompletionsAttempt.generate({ payload, ctx, store, candidate });
      if (result.type === 'events') return result;
    }
    return renderChatCompletionsFailure(
      sawAny ? { kind: 'model-unsupported', model: payload.model } : { kind: 'model-missing', model: payload.model },
    );
  },
};
