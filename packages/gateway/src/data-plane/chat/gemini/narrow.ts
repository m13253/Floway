import { classifyResponsesItemAffinity } from '../items/affinity.ts';
import type { ModelCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import { geminiViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const narrowGeminiByItemAffinity = async (input: {
  readonly payload: GeminiPayload;
  readonly candidates: readonly ModelCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<readonly ModelCandidate[] | ChatServeFailure> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.contents ?? [],
    view: geminiViaResponsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
  });
