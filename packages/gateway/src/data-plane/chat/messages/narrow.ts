import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const narrowMessagesByItemAffinity = async (input: {
  readonly payload: MessagesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<readonly ProviderCandidate[] | ChatServeFailure> =>
  await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: messagesViaResponsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
  });
