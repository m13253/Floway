import { chatCompletionsAttempt, chatCompletionsTarget } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import { applyChatRulesToChatCompletions } from '../../model-aliases/apply.ts';
import { resolveCandidatesAndApplyAlias } from '../../model-aliases/prelude.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
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
    const resolved = await resolveCandidatesAndApplyAlias({
      ctx,
      modelName: payload.model,
      kind: 'chat',
      endpointAccepts: chatCompletionsTarget.canServe,
      applyAlias: resolution => {
        payload.model = resolution.targetModelId;
        applyChatRulesToChatCompletions(payload, resolution.rules);
      },
      renderAliasFailure: renderChatCompletionsFailure,
    });
    if (resolved.kind === 'failure') return resolved.result;
    const { candidates, sawModel, failedUpstreams } = resolved;
    const viable = candidates.filter(c => chatCompletionsTarget.canServe(c.model.endpoints));
    const decision = await planChatCompletionsRouting({ payload, candidates: viable, store });
    if (decision.kind === 'failure') return renderChatCompletionsFailure(decision.failure);

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) return renderChatCompletionsFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams));
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate, headers });
  },
};
