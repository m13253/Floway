import { createStoredResponsesItemId, isStoredResponsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { LlmTargetApi, RequestContext } from '../../../interceptors.ts';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type {
  ResponsesItemFinalizedHandler,
  ResponsesItemIdMapper,
  ResponsesItemsView,
} from '@floway-dev/translate/via-responses/responses-items';

// Source-stream middleware that mints a gateway-owned stored id for every
// Responses item carrier in the outgoing source stream and persists the
// matching row before the carrier's finalizing frame reaches the client.
//
// Runs at the source-serve layer after all source interceptors, so items
// dropped or synthesized by interceptors are correctly reflected in
// persistence. The view's `streamMapIdAsResponsesItems` separates two
// concerns: per-frame id rewriting (sync via `idMapper`, real-time SSE
// preserved) and per-item persistence (async via `onItemFinalized`, awaited
// before the view yields the finalizing frame).
//
// One INSERT per stored id. The row carries the upstream's original item
// untouched in `payload.item`; the id field there is the upstream's id, not
// the stored id. `request-plan.ts` rewrites the id at expansion time based
// on routing.
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

  const idMapper: ResponsesItemIdMapper = (upstreamId, itemType) => {
    if (isStoredResponsesItemId(upstreamId)) {
      // Internal code carries upstream-original ids end-to-end; storedIds
      // only appear at this boundary on the way out. Seeing one as input
      // means a layer below us mistakenly emitted a gateway id — fail
      // loud rather than misroute future requests.
      throw new Error(`Upstream returned an id that parses as a gateway stored id; internal pipeline must not surface stored ids: ${upstreamId}`);
    }
    let storedId = upstreamToStored.get(upstreamId);
    if (storedId === undefined) {
      storedId = createStoredResponsesItemId(itemType);
      upstreamToStored.set(upstreamId, storedId);
    }
    return storedId;
  };

  const onItemFinalized: ResponsesItemFinalizedHandler = async (originalItem, newId) => {
    await getRepo().responsesItems.insertMany([buildRow(newId, originalItem, context, request)]);
  };

  return view.streamMapIdAsResponsesItems(frames, idMapper, onItemFinalized);
};

const buildRow = (
  newId: string,
  originalItem: ResponseInputItem,
  context: StoreResponsesContext,
  request: RequestContext,
): StoredResponsesItem => {
  const upstreamId = (originalItem as { id?: unknown }).id;
  if (typeof upstreamId !== 'string' || upstreamId.length === 0) {
    throw new Error(`Cannot persist Responses item without an upstream id (newId=${newId}, type=${originalItem.type})`);
  }
  const upstreamOwned = context.targetApi === 'responses';
  return {
    id: newId,
    apiKeyId: request.apiKeyId ?? null,
    upstreamId: upstreamOwned ? context.upstream : null,
    upstreamItemId: upstreamOwned ? upstreamId : null,
    itemType: originalItem.type,
    payload: context.store === false ? null : { item: originalItem },
    createdAt: Date.now(),
  };
};
