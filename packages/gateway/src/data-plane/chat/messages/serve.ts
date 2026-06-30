import { messagesAttempt, messagesGenerateTarget, messagesCountTokensTarget } from './attempt.ts';
import { renderMessagesFailure } from './errors.ts';
import { planMessagesRouting } from './routing.ts';
import { applyChatRulesToMessages } from '../../model-aliases/apply.ts';
import { resolveCandidatesAndApplyAlias } from '../../model-aliases/prelude.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { noViableCandidateFailure } from '../shared/errors.ts';
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

const applyAlias = (payload: MessagesPayload) => (resolution: { targetModelId: string; rules: Parameters<typeof applyChatRulesToMessages>[1] }) => {
  payload.model = resolution.targetModelId;
  applyChatRulesToMessages(payload, resolution.rules);
};

export const messagesServe = {
  generate: async (args: MessagesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    const { payload, ctx, store, headers } = args;
    const resolved = await resolveCandidatesAndApplyAlias({
      ctx,
      modelName: payload.model,
      kind: 'chat',
      endpointAccepts: messagesGenerateTarget.canServe,
      applyAlias: applyAlias(payload),
      renderAliasFailure: failure => renderMessagesFailure(failure, 'generate'),
    });
    if (resolved.kind === 'failure') return resolved.result;
    const { candidates, sawModel, failedUpstreams } = resolved;
    const viable = candidates.filter(c => messagesGenerateTarget.canServe(c.model.endpoints));
    const decision = await planMessagesRouting({ payload, candidates: viable, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision.candidates;
    if (candidate === undefined) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'generate');
    return await messagesAttempt.generate({ payload, ctx, store, candidate, headers });
  },

  countTokens: async (args: MessagesServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, headers } = args;
    const resolved = await resolveCandidatesAndApplyAlias({
      ctx,
      modelName: payload.model,
      kind: 'chat',
      endpointAccepts: messagesCountTokensTarget.canServe,
      applyAlias: applyAlias(payload),
      renderAliasFailure: failure => renderMessagesFailure(failure, 'countTokens'),
    });
    if (resolved.kind === 'failure') return resolved.result;
    const { candidates, sawModel, failedUpstreams } = resolved;
    const viable = candidates.filter(c => messagesCountTokensTarget.canServe(c.model.endpoints));
    const decision = await planMessagesRouting({ payload, candidates: viable, store });
    if (decision.kind === 'failure') return renderMessagesFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [candidate] = decision.candidates;
    if (candidate === undefined) return renderMessagesFailure(noViableCandidateFailure(sawModel, payload.model, failedUpstreams), 'countTokens');
    return await messagesAttempt.countTokens({ payload, ctx, store, candidate, headers });
  },
};
