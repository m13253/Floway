import { messagesAttempt, messagesGenerateTarget, messagesCountTokensTarget } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { isAttemptSuccess, isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface MessagesServeGenerateArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface MessagesServeCountTokensArgs {
  readonly payload: MessagesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = candidates.filter(c => messagesGenerateTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: messagesViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (isChatServeFailure(decision)) return renderMessagesFailure(decision, 'generate');
    if (decision.length === 0) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'generate',
      );
    }

    // Try each viable candidate in narrow-order. A successful attempt
    // (SSE stream opened) is the final answer; an api-error or
    // internal-error from one candidate falls through to the next so the
    // gateway's resilience absorbs transient 5xx/429/network failures.
    // The last failure is surfaced verbatim when the list is exhausted.
    let lastFailure: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | undefined;
    for (const candidate of decision) {
      const result = await messagesAttempt.generate({ payload, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = candidates.filter(c => messagesCountTokensTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.messages,
      view: messagesViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (isChatServeFailure(decision)) return renderMessagesFailure(decision, 'countTokens');
    if (decision.length === 0) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'countTokens',
      );
    }

    let lastFailure: ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult | undefined;
    for (const candidate of decision) {
      const result = await messagesAttempt.countTokens({ payload, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },
};
