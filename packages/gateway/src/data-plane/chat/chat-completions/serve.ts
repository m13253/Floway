import { chatCompletionsAttempt } from './attempt.ts';
import { renderChatCompletionsFailure } from './errors.ts';
import { planChatCompletionsRouting } from './routing.ts';
import { getRepo } from '../../../repo/index.ts';
import { applyAliasRulesToChatCompletions } from '../../model-aliases/apply.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { stageGatewayResponseHeader } from '../shared/gateway-ctx.ts';
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
    const aliases = await getRepo().modelAliases.loadAll();
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      aliases,
      pickTarget: endpoints =>
        endpoints.chatCompletions ? 'chat-completions'
          : endpoints.messages ? 'messages'
            : endpoints.responses ? 'responses'
              : null,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
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
    // Apply operator-locked alias rules to the inbound IR before the
    // attempt runs its interceptor chain. The matching `x-floway-alias`
    // header is staged via Hono's `c.header` so it survives `streamSSE`'s
    // internal `c.newResponse`.
    if (candidate.aliasRules) applyAliasRulesToChatCompletions(payload, candidate.aliasRules);
    if (candidate.aliasName) stageGatewayResponseHeader(ctx, 'x-floway-alias', candidate.aliasName);
    return await chatCompletionsAttempt.generate({ payload, ctx, store, candidate, headers });
  },
};
