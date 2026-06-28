import { pickCandidatesByItemAffinity } from '../responses/items/pick-by-affinity.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import { chatCompletionsViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const pickChatCompletionsCandidates = async (input: {
  readonly payload: ChatCompletionsPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<readonly ProviderCandidate[] | ChatServeFailure> =>
  await pickCandidatesByItemAffinity({
    sourceItems: input.payload.messages,
    view: chatCompletionsViaResponsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
