import { classifyResponsesItemAffinity } from './items/affinity.ts';
import { responsesItemsView } from './items/view.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { StatefulResponsesStore } from './items/store.ts';

export type ResponsesRoutingDecision = RoutingDecision;

export const planResponsesRouting = async (input: {
  readonly payload: ResponsesPayload;
  readonly candidates: readonly ProviderCandidate[];
  readonly store: StatefulResponsesStore;
}): Promise<ResponsesRoutingDecision> => {
  // `payload.input` is `string | ResponsesInputItem[]`. A bare string has no
  // item references to look up, so the affinity walk has nothing to do — the
  // native view's `visitAsResponsesItems` only accepts item arrays, so we
  // hand it an empty array in that case.
  const sourceItems = Array.isArray(input.payload.input) ? input.payload.input : [];
  const result = await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store: input.store,
    candidates: input.candidates,
  });
  if (result.kind === 'failure') return { kind: 'failure', failure: result.failure! };
  return { kind: 'success', candidates: result.candidates! };
};
