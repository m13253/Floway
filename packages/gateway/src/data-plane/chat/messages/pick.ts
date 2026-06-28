import { pickCandidatesByItemAffinity } from '../responses/items/pick-by-affinity.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import { messagesViaResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const pickMessagesCandidates = async (input: {
  readonly payload: MessagesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<readonly ProviderCandidate[] | ChatServeFailure> =>
  await pickCandidatesByItemAffinity({
    sourceItems: input.payload.messages,
    view: messagesViaResponsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
