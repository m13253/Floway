import { messagesAttempt, messagesGenerateTarget, messagesCountTokensTarget } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { pickMessagesCandidates } from './pick.ts';
import { enumerateProviderCandidates } from '../../providers/candidates.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

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

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => messagesGenerateTarget.canServe(c.model.endpoints));
    const candidates = await pickMessagesCandidates({ payload, candidates: viable, store });
    if (isChatServeFailure(candidates)) return renderMessagesFailure(candidates, 'generate');

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = candidates;
    if (candidate === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'generate',
      );
    }
    return await messagesAttempt.generate({ payload, ctx, store, candidate, headers });
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, headers } = args;
    const { candidates: enumerated, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = enumerated.filter(c => messagesCountTokensTarget.canServe(c.model.endpoints));
    const candidates = await pickMessagesCandidates({ payload, candidates: viable, store });
    if (isChatServeFailure(candidates)) return renderMessagesFailure(candidates, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [candidate] = candidates;
    if (candidate === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'countTokens',
      );
    }
    return await messagesAttempt.countTokens({ payload, ctx, store, candidate, headers });
  },
};
