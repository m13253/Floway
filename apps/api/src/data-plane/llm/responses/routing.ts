import { classifyResponsesItemAffinity } from './items/affinity.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const planResponsesRouting = async (input: {
  readonly payload: ResponsesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<RoutingDecision> => {
  // `payload.input` is `string | ResponsesInputItem[]`. A bare string has no
  // item references to look up, so the affinity walk has nothing to do — the
  // native view's `visitAsResponsesItems` only accepts item arrays, so we
  // hand it an empty array in that case.
  const sourceItems = Array.isArray(input.payload.input) ? input.payload.input : [];
  const inputItemsToStage: readonly ResponsesInputItem[] = typeof input.payload.input === 'string'
    ? [{ type: 'message', role: 'user', content: input.payload.input }]
    : input.payload.input;
  return await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store: input.store,
    candidates: input.candidates,
    inputItemsToStage,
  });
};
