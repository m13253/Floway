import { createStoredResponsesItemId, isStoredResponsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { LlmTargetApi, RequestContext } from '../../../interceptors.ts';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesItemMapper, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

// Source-stream middleware that gives every via-responses-carrying item in
// the outgoing source stream a gateway-owned stored id and persists the
// matching row before the carrier frame reaches the client.
//
// Operates at the source-serve layer (after all source interceptors), so
// items synthesized inside source interceptors (e.g. the Responses web
// search shim's `web_search_call` items) are captured, and items dropped
// by interceptors before reaching this point are not persisted.
//
// Per-row persistence is awaited inside the mapper: by the time the view
// yields a frame carrying the rewritten storedId, the row is in D1. Later
// mapper invocations for the same upstream id (Responses `output_item.done`,
// Chat's repeated chunks per reasoning id) re-issue an INSERT whose
// `ON CONFLICT DO UPDATE` keeps the latest payload while leaving the first
// observation's upstream affinity pinned.
export interface StoreResponsesContext {
  readonly targetApi: LlmTargetApi;
  readonly upstream: string;
  readonly store: boolean | null | undefined;
}

export const storeResponsesOutputItems = <TFrame>(
  frames: AsyncIterable<TFrame>,
  view: ResponsesItemsView<unknown, unknown, TFrame>,
  context: StoreResponsesContext,
  request: RequestContext,
): AsyncIterable<TFrame> => {
  const upstreamToStored = new Map<string, string>();

  const mapper: ResponsesItemMapper = async (item: ResponseInputItem) => {
    const upstreamId = (item as { id?: unknown }).id;
    if (typeof upstreamId !== 'string' || upstreamId.length === 0) return item;

    let storedId = upstreamToStored.get(upstreamId);
    if (storedId === undefined) {
      storedId = createStoredResponsesItemId(item.type);
      upstreamToStored.set(upstreamId, storedId);
    }
    const itemWithStoredId = { ...item, id: storedId } as ResponseInputItem;
    await getRepo().responsesItems.insertMany([
      buildStoredItemRow(storedId, upstreamId, item.type, itemWithStoredId, context, request),
    ]);
    return itemWithStoredId;
  };

  return view.mapStreamAsResponsesItems(frames, mapper);
};

const buildStoredItemRow = (
  storedId: string,
  upstreamId: string,
  itemType: string,
  itemWithStoredId: ResponseInputItem,
  context: StoreResponsesContext,
  request: RequestContext,
): StoredResponsesItem => {
  const upstreamOwned = context.targetApi === 'responses' && !isStoredResponsesItemId(upstreamId);
  return {
    id: storedId,
    apiKeyId: request.apiKeyId ?? null,
    upstreamId: upstreamOwned ? context.upstream : null,
    upstreamItemId: upstreamOwned ? upstreamId : null,
    itemType,
    payload: context.store === false ? null : { item: structuredClone(itemWithStoredId) },
    createdAt: Date.now(),
  };
};
