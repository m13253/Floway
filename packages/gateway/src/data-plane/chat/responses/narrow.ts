import { classifyResponsesItemAffinity } from '../items/affinity.ts';
import type { ModelCandidate } from '../shared/candidates.ts';
import type { ChatServeFailure } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';
import { responsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export const narrowResponsesByItemAffinity = async (input: {
  readonly payload: ResponsesPayload;
  readonly candidates: readonly ModelCandidate[];
  readonly ctx: ChatGatewayCtx;
}): Promise<readonly ModelCandidate[] | ChatServeFailure> => {
  // A bare-string input is wrapped into a synthetic user message for staging;
  // the affinity walk receives an empty item array since strings carry no
  // item references to resolve.
  const { sourceItems, inputItemsToStage }: {
    sourceItems: readonly ResponsesInputItem[];
    inputItemsToStage: readonly ResponsesInputItem[];
  } = typeof input.payload.input === 'string'
    ? { sourceItems: [], inputItemsToStage: [{ type: 'message', role: 'user', content: input.payload.input }] }
    : { sourceItems: input.payload.input, inputItemsToStage: input.payload.input };
  return await classifyResponsesItemAffinity({
    sourceItems,
    view: responsesItemsView,
    store: input.ctx.store,
    candidates: input.candidates,
    inputItemsToStage,
  });
};
