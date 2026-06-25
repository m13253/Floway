import { messagesAttempt } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { planMessagesRouting } from './routing.ts';
import { getRepo } from '../../../repo/index.ts';
import { applyAliasRulesToMessages } from '../../model-aliases/apply.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import { stageGatewayResponseHeader } from '../shared/gateway-ctx.ts';
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
    const aliases = await getRepo().modelAliases.loadAll();
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      aliases,
      pickTarget: endpoints =>
        endpoints.messages ? 'messages'
          : endpoints.responses ? 'responses'
            : endpoints.chatCompletions ? 'chat-completions'
              : null,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const decision = await planMessagesRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'generate',
      );
    }
    // Operator-locked alias rules go onto the inbound IR before the attempt
    // begins so the per-protocol interceptor chain (and any downstream
    // translate pass) sees the already-injected fields. The matching
    // `x-floway-alias` header is staged via Hono's `c.header` so it
    // survives `streamSSE`'s internal `c.newResponse`.
    if (candidate.aliasRules) applyAliasRulesToMessages(payload, candidate.aliasRules);
    if (candidate.aliasName) stageGatewayResponseHeader(ctx, 'x-floway-alias', candidate.aliasName);
    return await messagesAttempt.generate({ payload, ctx, store, candidate, headers });
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, headers } = args;
    const aliases = await getRepo().modelAliases.loadAll();
    const { candidates, sawModel, failedUpstreams } = await enumerateProviderCandidates({
      upstreamIds: ctx.upstreamIds,
      model: payload.model,
      aliases,
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const decision = await planMessagesRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [candidate] = decision.candidates;
    if (candidate === undefined) {
      return renderMessagesFailure(
        sawModel
          ? { kind: 'model-unsupported', model: payload.model, failedUpstreams }
          : { kind: 'model-missing', model: payload.model, failedUpstreams },
        'countTokens',
      );
    }
    // count_tokens carries the same alias semantics as generate — operator
    // rules apply uniformly regardless of endpoint, and the response header
    // rides out the same way.
    if (candidate.aliasRules) applyAliasRulesToMessages(payload, candidate.aliasRules);
    if (candidate.aliasName) stageGatewayResponseHeader(ctx, 'x-floway-alias', candidate.aliasName);
    return await messagesAttempt.countTokens({ payload, ctx, store, candidate, headers });
  },
};
