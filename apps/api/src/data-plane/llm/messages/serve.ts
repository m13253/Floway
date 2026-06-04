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
    const candidates = await enumerateProviderCandidates({
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

    let sawAny = false;
    for (const candidate of decision.candidates) {
      sawAny = true;
      const result = await messagesAttempt.generate({ payload, ctx, store, candidate, anthropicBeta });
      if (result.type === 'events') return result;
    }
    return renderMessagesFailure(
      sawAny ? { kind: 'model-unsupported', model: payload.model } : { kind: 'model-missing', model: payload.model },
      'generate',
    );
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, anthropicBeta } = args;
    const candidates = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model: payload.model,
      sourceApi: 'messages',
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
    });
    const decision = await planMessagesRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');

    let sawAny = false;
    for (const candidate of decision.candidates) {
      sawAny = true;
      const result = await messagesAttempt.countTokens({ payload, ctx, store, candidate, anthropicBeta });
      // PlainResult always represents a final response — both 2xx and upstream
      // errors come back as a `plain` envelope, so iteration stops on the first
      // candidate. Provider-level transport errors would throw and propagate.
      return result;
    }
    return renderMessagesFailure(
      sawAny ? { kind: 'model-unsupported', model: payload.model } : { kind: 'model-missing', model: payload.model },
      'countTokens',
    );
  },
};
