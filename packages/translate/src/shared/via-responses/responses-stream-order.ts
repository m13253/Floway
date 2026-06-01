import type { ResponsesOutputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export interface ResponsesOutputOrderState {
  pendingOutputIndexes: Set<number>;
  deferredEvents: ResponsesStreamEvent[];
}

export type ShouldTrackResponsesOutputItem = (item: ResponsesOutputItem, outputIndex: number) => boolean;

export const createResponsesOutputOrderState = (): ResponsesOutputOrderState => ({
  pendingOutputIndexes: new Set(),
  deferredEvents: [],
});

const getOutputIndex = (event: ResponsesStreamEvent): number | undefined => ('output_index' in event && typeof event.output_index === 'number' ? event.output_index : undefined);

// Responses can interleave deltas for multiple output items. Downstream Chat
// scalar reasoning and Anthropic content blocks are not safely retractable once
// emitted, so visible later-output events wait for earlier tracked items to end.
export const shouldDeferForEarlierResponsesOutput = (event: ResponsesStreamEvent, state: ResponsesOutputOrderState): boolean => {
  const outputIndex = getOutputIndex(event);
  if (outputIndex === undefined) return false;

  for (const pendingIndex of state.pendingOutputIndexes) {
    if (pendingIndex < outputIndex) return true;
  }

  return false;
};

type ResponsesOutputItemAddedEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.added' }>;

type ResponsesOutputItemDoneEvent = Extract<ResponsesStreamEvent, { type: 'response.output_item.done' }>;

const isOutputItemAddedEvent = (event: ResponsesStreamEvent): event is ResponsesOutputItemAddedEvent => event.type === 'response.output_item.added';

const isOutputItemDoneEvent = (event: ResponsesStreamEvent): event is ResponsesOutputItemDoneEvent => event.type === 'response.output_item.done';

export const recordResponsesOutputOrderEvent = (event: ResponsesStreamEvent, state: ResponsesOutputOrderState, shouldTrack: ShouldTrackResponsesOutputItem): void => {
  if (isOutputItemAddedEvent(event)) {
    if (shouldTrack(event.item, event.output_index)) {
      state.pendingOutputIndexes.add(event.output_index);
    }
    return;
  }

  if (isOutputItemDoneEvent(event)) {
    state.pendingOutputIndexes.delete(event.output_index);
  }
};
