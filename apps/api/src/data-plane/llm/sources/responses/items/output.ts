import { createStoredResponsesItemId, createTemporaryResponsesItemId, isKnownResponsesItemType, isStoredResponsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { RequestContext, ResponsesInvocation } from '../../../interceptors.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponseOutputItem, ResponsesStreamEvent, ResponseStreamEvent } from '@floway-dev/protocols/responses';

interface OutputItemState {
  storedId?: string;
}

interface QueuedFrame {
  dependencies: readonly number[];
  rewrite: () => ProtocolFrame<ResponsesStreamEvent>;
}

const gatewaySyntheticItemIdPattern = /^[a-z]+_(?:gw|tmp)_/u;
const translatorSyntheticItemIdPattern = /^[a-z]+_\d+$/u;
const copilotSyntheticItemIdPattern = /^oi_\d+_[A-Za-z0-9_-]{16}$/u;

export const storeResponsesOutputItems = async function* (
  frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
  invocation: ResponsesInvocation,
  request: RequestContext,
): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
  const states = new Map<number, OutputItemState>();
  const queued: QueuedFrame[] = [];
  const queuedRowIds = new Set(invocation.responsesNewItems.map(item => item.id));
  let persistedRowCount = 0;

  const stateFor = (outputIndex: number): OutputItemState => {
    let state = states.get(outputIndex);
    if (!state) {
      state = {};
      states.set(outputIndex, state);
    }
    return state;
  };

  const queue = (entry: QueuedFrame): void => {
    queued.push(entry);
  };

  const flushReady = function* (): Generator<ProtocolFrame<ResponsesStreamEvent>> {
    while (queued.length > 0 && queued[0].dependencies.every(outputIndex => stateFor(outputIndex).storedId !== undefined)) {
      yield queued.shift()!.rewrite();
    }
  };

  const persistNewRows = async (): Promise<void> => {
    const start = persistedRowCount;
    const end = invocation.responsesNewItems.length;
    if (start === end) return;
    persistedRowCount = end;
    await getRepo().responsesItems.insertMany(invocation.responsesNewItems.slice(start, end));
  };

  const completeOutputItem = (outputIndex: number, item: ResponseOutputItem): string => {
    const state = stateFor(outputIndex);
    if (state.storedId !== undefined) return state.storedId;

    const hashItem = itemId(item) === null ? rewriteItemId(item, createTemporaryResponsesItemId(item.type)) : item;
    const storedId = createStoredResponsesItemId(hashItem.type, hashItem);
    state.storedId = storedId;
    if (!queuedRowIds.has(storedId)) {
      invocation.responsesNewItems.push(createStoredItemRow(storedId, hashItem, invocation, request));
      queuedRowIds.add(storedId);
    }
    return storedId;
  };

  for await (const frame of frames) {
    if (frame.type !== 'event') {
      if (queued.length === 0) {
        yield frame;
      } else {
        queue({ dependencies: [], rewrite: () => frame });
        yield* flushReady();
      }
      continue;
    }

    const event = frame.event;

    if (event.type === 'response.completed' || event.type === 'response.incomplete') {
      const rewrittenTerminal = rewriteSuccessfulTerminal(event, completeOutputItem);
      await persistNewRows();
      yield* flushReady();
      yield { ...frame, event: rewrittenTerminal };
      return;
    }

    if (event.type === 'response.failed' || event.type === 'error') {
      await persistNewRows();
      yield* flushReady();
      yield frame;
      return;
    }

    if (event.type === 'response.output_item.added') {
      const outputIndex = event.output_index;
      stateFor(outputIndex);
      queue({
        dependencies: [outputIndex],
        rewrite: () => ({
          ...frame,
          event: {
            ...event,
            item: rewriteItemId(event.item, stateFor(outputIndex).storedId!),
          },
        }),
      });
      continue;
    }

    if (event.type === 'response.output_item.done') {
      const outputIndex = event.output_index;
      completeOutputItem(outputIndex, event.item);
      await persistNewRows();
      queue({
        dependencies: [outputIndex],
        rewrite: () => ({
          ...frame,
          event: {
            ...event,
            item: rewriteItemId(event.item, stateFor(outputIndex).storedId!),
          },
        }),
      });
      continue;
    }

    if (hasOutputItemId(event)) {
      const outputIndex = event.output_index;
      stateFor(outputIndex);
      queue({
        dependencies: [outputIndex],
        rewrite: () => ({
          ...frame,
          event: {
            ...event,
            item_id: stateFor(outputIndex).storedId!,
          } as ResponsesStreamEvent,
        }),
      });
      continue;
    }

    if (queued.length === 0) {
      yield frame;
    } else {
      queue({ dependencies: [], rewrite: () => frame });
    }
  }
};

const rewriteSuccessfulTerminal = (
  event: Extract<ResponseStreamEvent, { type: 'response.completed' | 'response.incomplete' }>,
  completeOutputItem: (outputIndex: number, item: ResponseOutputItem) => string,
): ResponsesStreamEvent => ({
  ...event,
  response: {
    ...event.response,
    output: event.response.output.map((item, outputIndex) => rewriteItemId(item, completeOutputItem(outputIndex, item))),
  },
});

const rewriteItemId = (item: ResponseOutputItem, storedId: string): ResponseOutputItem => {
  if (!isKnownResponsesItemType(item.type)) {
    throw new TypeError(`Cannot rewrite id on unknown Responses item type '${item.type}'`);
  }
  return { ...item, id: storedId } as ResponseOutputItem;
};

const createStoredItemRow = (
  storedId: string,
  originalItem: ResponseOutputItem,
  invocation: ResponsesInvocation,
  request: RequestContext,
): StoredResponsesItem => {
  const upstreamItemId = upstreamOwnedItemId(invocation, originalItem);
  const downstreamItem = rewriteItemId(originalItem, storedId);
  return {
    id: storedId,
    apiKeyId: request.apiKeyId ?? null,
    upstreamId: upstreamItemId === null ? null : invocation.upstream,
    upstreamItemId,
    itemType: originalItem.type,
    payload: invocation.payload.store === false ? null : { item: structuredClone(downstreamItem) },
    createdAt: Date.now(),
  };
};

const upstreamOwnedItemId = (invocation: ResponsesInvocation, item: ResponseOutputItem): string | null => {
  if (invocation.targetApi !== 'responses') return null;
  const id = itemId(item);
  if (id === null) return null;
  if (isStoredResponsesItemId(id) || gatewaySyntheticItemIdPattern.test(id) || translatorSyntheticItemIdPattern.test(id) || copilotSyntheticItemIdPattern.test(id)) return null;
  return id;
};

const itemId = (item: ResponseOutputItem): string | null => {
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};

const hasOutputItemId = (event: ResponsesStreamEvent): event is ResponsesStreamEvent & { output_index: number; item_id: string } =>
  typeof (event as { output_index?: unknown }).output_index === 'number'
  && typeof (event as { item_id?: unknown }).item_id === 'string';
