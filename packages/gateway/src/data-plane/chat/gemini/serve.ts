import { geminiAttempt, geminiGenerateTarget, geminiCountTokensTarget } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import { isAttemptSuccess, isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export interface GeminiServeGenerateArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  // Per-request model id (Gemini carries it in the URL path, not the body),
  // resolved by the HTTP entry and threaded through here so candidate
  // enumeration and failure rendering all see the same value.
  readonly model: string;
  readonly headers: Headers;
}

export interface GeminiServeCountTokensArgs {
  readonly payload: GeminiPayload;
  readonly ctx: ChatGatewayCtx;
  readonly model: string;
  readonly headers: Headers;
}

export const geminiServe = {
  generate: async (args: GeminiServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> => {
    const { payload, ctx, model, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = candidates.filter(c => geminiGenerateTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.contents ?? [],
      view: geminiViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (isChatServeFailure(decision)) return renderGeminiFailure(decision, 'generate');
    if (decision.length === 0) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model, failedUpstreams }
          : { kind: 'model-missing', model, failedUpstreams },
        'generate',
      );
    }

    let lastFailure: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | undefined;
    for (const candidate of decision) {
      const result = await geminiAttempt.generate({ payload, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },

  countTokens: async (args: GeminiServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult> => {
    const { payload, ctx, model, headers } = args;
    const { candidates, sawModel, failedUpstreams } = await enumerateModelCandidates({
      upstreamIds: ctx.upstreamIds,
      model,
      kind: 'chat',
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
    const viable = candidates.filter(c => geminiCountTokensTarget.canServe(c.model.endpoints));
    const decision = await classifyResponsesItemAffinity({
      sourceItems: payload.contents ?? [],
      view: geminiViaResponsesItemsView,
      store: ctx.store,
      candidates: viable,
    });
    if (isChatServeFailure(decision)) return renderGeminiFailure(decision, 'countTokens');
    if (decision.length === 0) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model, failedUpstreams }
          : { kind: 'model-missing', model, failedUpstreams },
        'countTokens',
      );
    }

    let lastFailure: ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult | undefined;
    for (const candidate of decision) {
      const result = await geminiAttempt.countTokens({ payload, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },
};
