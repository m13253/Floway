import { classifyResponsesItemAffinity } from '../items/affinity.ts';
import type { ModelCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const narrowChatCompletionsByItemAffinity = async (input: {
  readonly payload: ChatCompletionsPayload;
  readonly candidates: readonly ModelCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<readonly ModelCandidate[] | ChatServeFailure> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: chatCompletionsViaResponsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
  });
