import { classifyResponsesItemAffinity } from './items/affinity.ts';
import { responsesItemsView } from './items/view.ts';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { RoutingDecision } from '../shared/routing.ts';
import type { StatefulResponsesStore } from './items/store.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

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
  // Pre-load stored rows whose content hash matches a payload input item so a
  // duplicate user message resent on a later turn reuses the existing row
  // instead of minting a fresh one.
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
