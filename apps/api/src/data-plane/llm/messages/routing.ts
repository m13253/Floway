import { messagesViaResponsesItemsView } from './view.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

export type MessagesRoutingDecision = RoutingDecision;

export const planMessagesRouting = async (input: {
  readonly payload: MessagesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<MessagesRoutingDecision> => {
  const result = await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: messagesViaResponsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
  if (result.kind === 'failure') return { kind: 'failure', failure: result.failure! };
  return { kind: 'success', candidates: result.candidates! };
};
