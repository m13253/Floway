import { messagesAttempt } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { planMessagesRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates, planChatCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ModelEndpoints, ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ChatTargetApi, ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface MessagesServeGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

export interface MessagesServeCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly headers: Headers;
}

// `/v1/messages` generate prefers a native Messages target, then the
// translated Responses path, then the translated Chat Completions path.
const pickMessagesGenerateTarget = (endpoints: ModelEndpoints): ChatTargetApi | null =>
  endpoints.messages ? 'messages'
    : endpoints.responses ? 'responses'
      : endpoints.chatCompletions ? 'chat-completions'
        : null;

// `count_tokens` has no translation path — only a native Messages target
// satisfies the operation.
const pickMessagesCountTokensTarget = (endpoints: ModelEndpoints): ChatTargetApi | null =>
  endpoints.messages ? 'messages' : null;

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const planItems = planChatCandidates(candidates, pickMessagesGenerateTarget);
    const decision = await planMessagesRouting({ payload, candidates: planItems, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [item] = decision.candidates;
    if (item === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'generate',
      );
    }
    return await messagesAttempt.generate({ payload, ctx, store, candidate: item.candidate, targetApi: item.targetApi, headers });
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const planItems = planChatCandidates(candidates, pickMessagesCountTokensTarget);
    const decision = await planMessagesRouting({ payload, candidates: planItems, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [item] = decision.candidates;
    if (item === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'countTokens',
      );
    }
    return await messagesAttempt.countTokens({ payload, ctx, store, candidate: item.candidate, targetApi: item.targetApi, headers });
  },
};
