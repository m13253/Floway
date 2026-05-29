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
// matching row.
//
// Runs at the source-serve layer after all source interceptors, so items
// dropped or synthesized by interceptors are correctly reflected in
// persistence. The view's `streamMapIdAsResponsesItems` separates two
// concerns: per-frame id rewriting (sync via `idMapper`, real-time SSE
// preserved) and per-item persistence (async via `onItemFinalized`, fired at
// each carrier's finalizing frame).
//
// Persistence must reflect only what the client actually saw, so the moment a
// row reaches the repo depends on the transport:
//
// - Streaming ('immediate'): the handler writes each row through to the repo
//   as its item finalizes — at the carrier's done frame, just before that
//   frame is yielded onward — and a mid-stream client abort still leaves the
//   items finalized so far persisted. `commit` is a no-op.
//
// - Non-streaming ('deferred'): the response is assembled by draining this
//   whole stream into one JSON body; an item-done followed by a stream-level
//   error makes the reassembler throw and the request returns 502 with no
//   body. Persisting per item during that drain would leave rows for items
//   the client never received. So the handler only buffers finalized rows,
//   and `commit` flushes them in a single INSERT — called by the respond
//   layer exclusively on the success branch, after the body is known good.
//
// One INSERT per stored id. The row carries the upstream's original item
// untouched in `payload.item` (or null payload when the request opted out of
// storage via `store: false`); the id field there is the upstream's id, not
// the stored id. `request-plan.ts` rewrites the id at expansion time based
// on routing.
export interface StoreResponsesContext {
  readonly targetApi: LlmTargetApi;
  readonly upstream: string;
  readonly store: boolean | null | undefined;
}

// Flushes rows buffered during a non-streaming drain. A no-op in streaming
// mode, where rows were already written through as items were delivered.
export type ResponsesItemsCommit = () => Promise<void>;

// Persisting stored items is opportunistic: the rows let later requests
// reference prior items, but a storage failure must never sink an
// already-assembled, billable response. The respond layer calls this only
// after the body is known good (so truncated/failed drains persist nothing)
// and after usage is recorded; a failed write is logged and swallowed rather
// than surfaced to the client, matching how telemetry side-effects are handled.
export const commitStoredItemsBestEffort = async (commit: ResponsesItemsCommit): Promise<void> => {
  try {
    await commit();
  } catch (error) {
    console.error('Failed to persist stored Responses items:', error);
  }
};

// Stand-in commit for results that never wrapped a stored-items stream
// (upstream/internal errors), so the respond layer can call commit
// unconditionally on the success path without branching on result shape.
export const noopResponsesItemsCommit: ResponsesItemsCommit = () => Promise.resolve();

export interface StoredResponsesItemsStream<TFrame> {
  readonly events: AsyncIterable<TFrame>;
  readonly commit: ResponsesItemsCommit;
}

export const storeResponsesOutputItems = <TFrame>(
  frames: AsyncIterable<TFrame>,
  view: ResponsesItemsView<unknown, unknown, TFrame>,
  context: StoreResponsesContext,
  request: RequestContext,
  wantsStream: boolean,
): StoredResponsesItemsStream<TFrame> => {
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

  const buffer: StoredResponsesItem[] = [];
  const onItemFinalized: ResponsesItemFinalizedHandler = async (originalItem, newId) => {
    const row = buildRow(newId, originalItem, context, request);
    if (wantsStream) {
      await getRepo().responsesItems.insertMany([row]);
    } else {
      buffer.push(row);
    }
  };

  const commit: ResponsesItemsCommit = async () => {
    if (buffer.length === 0) return;
    await getRepo().responsesItems.insertMany(buffer);
  };

  return { events: view.streamMapIdAsResponsesItems(frames, idMapper, onItemFinalized), commit };
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
