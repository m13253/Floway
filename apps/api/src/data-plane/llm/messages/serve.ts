import { messagesAttempt } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { planMessagesRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface MessagesServeGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly anthropicBeta?: readonly string[];
}

export interface MessagesServeCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly anthropicBeta?: readonly string[];
}

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, anthropicBeta } = args;
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: payload.model,
      sourceApi: 'messages',
      pickTarget: endpoints =>
        endpoints.messages ? 'messages'
          : endpoints.responses ? 'responses'
            : endpoints.chatCompletions ? 'chat-completions'
              : null,
    });
    const decision = await planMessagesRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, upstream-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream. Iteration only loops if the candidate list is empty.
    for (const candidate of decision.candidates) {
      return await messagesAttempt.generate({ payload, ctx, store, candidate, sourceApi: 'messages', anthropicBeta });
    }
    return renderMessagesFailure(
      sawModel
        ? { kind: 'model-unsupported', model: payload.model }
        : { kind: 'model-missing', model: payload.model },
      'generate',
    );
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, anthropicBeta } = args;
    const { candidates, sawModel } = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: payload.model,
      sourceApi: 'messages',
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
    });
    const decision = await planMessagesRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so iteration stops on the first
    // candidate. Provider-level transport errors throw and propagate.
    for (const candidate of decision.candidates) {
      return await messagesAttempt.countTokens({ payload, ctx, store, candidate, sourceApi: 'messages', anthropicBeta });
    }
    return renderMessagesFailure(
      sawModel
        ? { kind: 'model-unsupported', model: payload.model }
        : { kind: 'model-missing', model: payload.model },
      'countTokens',
    );
  },
};
