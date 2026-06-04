import { chatCompletionsViaResponsesItemsView } from './view.ts';
import { classifyResponsesItemAffinity } from '../responses/items/affinity.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

export type ChatCompletionsRoutingDecision = RoutingDecision;

export const planChatCompletionsRouting = async (input: {
  readonly payload: ChatCompletionsPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<ChatCompletionsRoutingDecision> => {
  const result = await classifyResponsesItemAffinity({
    sourceItems: input.payload.messages,
    view: chatCompletionsViaResponsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
  if (result.kind === 'failure') return { kind: 'failure', failure: result.failure! };
  return { kind: 'success', candidates: result.candidates! };
};
