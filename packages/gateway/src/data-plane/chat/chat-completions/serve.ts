import { chatCompletionsAttempt } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import { ALIAS_RESPONSE_HEADER, applyChatRulesToChatCompletions } from '../../model-aliases/apply.ts';
import { AliasNoTargetAvailableError } from '../../model-aliases/resolve.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import { aliasFailureFromError } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsServeGenerateArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

export const chatCompletionsServe = {
  generate: async (args: ChatCompletionsServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    let enumerated;
    try {
      enumerated = await enumerateProviderCandidates({
        upstreamIds: ctx.upstreamIds,
        model: payload.model,
        pickTarget: endpoints =>
          endpoints.chatCompletions ? 'chat-completions'
            : endpoints.messages ? 'messages'
              : endpoints.responses ? 'responses'
                : null,
        scheduler: ctx.backgroundScheduler,
        currentColo: ctx.currentColo,
      });
    } catch (error) {
      if (error instanceof AliasNoTargetAvailableError) return renderChatCompletionsFailure(aliasFailureFromError(error));
      throw error;
    }
    const { candidates, sawModel, failedUpstreams, aliasResolution } = enumerated;
    if (aliasResolution) {
      payload.model = aliasResolution.targetModelId;
      applyChatRulesToChatCompletions(payload, aliasResolution.rules);
      ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, aliasResolution.aliasName);
    }
    const decision = await planChatCompletionsRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderChatCompletionsFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
      );
    }
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate, headers });
  },
};
