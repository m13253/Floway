import { geminiAttempt } from './attempt.ts';
import { renderGeminiFailure } from './errors.ts';
import { planGeminiRouting } from './routing.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import { enumerateProviderCandidates } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface GeminiServeGenerateArgs {
  readonly payload: GeminiPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  // Per-request model id (Gemini carries it in the URL path, not the body),
  // resolved by the HTTP entry and threaded through here so candidate
  // enumeration and failure rendering all see the same value.
  readonly model: string;
}

export interface GeminiServeCountTokensArgs {
  readonly payload: GeminiPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly model: string;
}

export const geminiServe = {
  generate: async (args: GeminiServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>>> => {
    const { payload, ctx, store, model } = args;
    const candidates = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model,
      sourceApi: 'gemini',
      // Gemini has no native upstream target in the provider API; prefer
      // Chat Completions, then Messages, then Responses. Matches legacy
      // `sources/gemini/traits.ts:93`.
      pickTarget: endpoints => endpoints.chatCompletions ? 'chat-completions' : endpoints.messages ? 'messages' : endpoints.responses ? 'responses' : null,
    });
    const decision = await planGeminiRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'generate');

    // Any non-throwing attempt result — events, upstream-error, or
    // internal-error — IS the answer for this request: an upstream 4xx/5xx
    // from the first viable candidate is final, not a hint to try another
    // upstream. Iteration only loops if the candidate list is empty.
    for (const candidate of decision.candidates) {
      return await geminiAttempt.generate({ payload, ctx, store, candidate });
    }
    return renderGeminiFailure(
      candidates.length > 0
        ? { kind: 'model-unsupported', model }
        : { kind: 'model-missing', model },
      'generate',
    );
  },

  countTokens: async (args: GeminiServeCountTokensArgs): Promise<ExecuteResult<ProtocolFrame<GeminiStreamEvent>> | PlainResult> => {
    const { payload, ctx, store, model } = args;
    const candidates = await enumerateProviderCandidates({
      apiKeyUpstreamIds: ctx.apiKeyUpstreamIds,
      model,
      sourceApi: 'gemini',
      // Gemini countTokens has no native upstream support; only providers
      // exposing the Messages endpoint qualify because we translate Gemini
      // → Messages and call Messages count_tokens upstream.
      pickTarget: endpoints => endpoints.messages ? 'messages' : null,
    });
    const decision = await planGeminiRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'countTokens');

    const decision = await planGeminiRouting({ payload, candidates, store });
    if (decision.kind === 'failure') return renderGeminiFailure(decision.failure, 'countTokens');

    // PlainResult always represents a final response — both 2xx and upstream
    // errors come back as a `plain` envelope, so iteration stops on the first
    // candidate. Provider-level transport errors throw and propagate.
    for (const candidate of decision.candidates) {
      return await geminiAttempt.countTokens({ payload, ctx, store, candidate });
    }
    return renderGeminiFailure(
      candidates.length > 0
        ? { kind: 'model-unsupported', model }
        : { kind: 'model-missing', model },
      'countTokens',
    );
  },
};
