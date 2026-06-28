import { geminiAttempt, geminiGenerateTarget, geminiCountTokensTarget } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { narrowGeminiByItemAffinity } from './narrow.ts';
import { enumerateModelCandidates } from '../../providers/candidates.ts';
import { isChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

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
    const decision = await narrowGeminiByItemAffinity({ payload, candidates: viable, ctx });
    if (isChatServeFailure(decision)) return renderGeminiFailure(decision, 'generate');

    // Any non-throwing attempt result — events, api-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream.
    const [candidate] = decision;
    if (candidate === undefined) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model, failedUpstreams }
          : { kind: 'model-missing', model, failedUpstreams },
        'generate',
      );
    }
    return await geminiAttempt.generate({ payload, ctx, candidate, headers });
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
    const decision = await narrowGeminiByItemAffinity({ payload, candidates: viable, ctx });
    if (isChatServeFailure(decision)) return renderGeminiFailure(decision, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so the first candidate's result
    // is the answer. Provider-level transport errors throw and propagate.
    const [candidate] = decision;
    if (candidate === undefined) {
      return renderGeminiFailure(
        sawModel
          ? { kind: 'model-unsupported', model, failedUpstreams }
          : { kind: 'model-missing', model, failedUpstreams },
        'countTokens',
      );
    }
    return await geminiAttempt.countTokens({ payload, ctx, candidate, headers });
  },
};
