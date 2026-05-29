import { createStoredResponsesItemId, hashResponsesItemEncryptedContent, responsesItemEncryptedContent } from './format.ts';
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
// concerns: per-frame id rewriting (sync via `idMapper`) and per-item
// persistence (via `onItemFinalized`, fired at each carrier's finalizing
// frame).
//
// Persistence is opportunistic but read-after-write consistent. A failed
// write must never sink an already-billable response, so every insert
// swallows its error (logged); but the row must be visible by the time the
// client could reference the stored id, so the insert is awaited rather than
// fired off:
//
// - Streaming: the row is awaited at the carrier's done frame, just before
//   that frame is yielded onward, so a client that has seen `done` finds the
//   row on its next turn. The stored id is exposed earlier at the added
//   frame; the added->done replay race is accepted. `commit` is a no-op.
//
// - Non-streaming: the response is assembled by draining the whole stream
//   into one JSON body; an item-done followed by a stream-level error makes
//   the reassembler throw and the request returns 502 with no body. Persisting
//   per item during that drain would leave rows for items the client never
//   received, so the handler only buffers finalized rows and `commit` writes
//   the batch — awaited by the respond layer on the success branch, after the
//   body is known good, so the returned ids are immediately referenceable.
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

// Writes rows buffered during a non-streaming drain. A no-op in streaming
// mode, where each row was already written at its done frame.
export type ResponsesItemsCommit = () => Promise<void>;

export interface StoredResponsesItemsStream<TFrame> {
  readonly events: AsyncIterable<TFrame>;
  readonly commit: ResponsesItemsCommit;
}

export const storeResponsesOutputItems = <TFrame>(
  frames: AsyncIterable<TFrame>,
  view: Pick<ResponsesItemsView<never, TFrame>, 'streamMapIdAsResponsesItems'>,
  context: StoreResponsesContext,
  request: RequestContext,
  wantsStream: boolean,
): StoredResponsesItemsStream<TFrame> => {
  const upstreamToStored = new Map<string, string>();

  // Every upstream id maps to a fresh gateway stored id, memoized so repeated
  // frames for the same item resolve to one id. An upstream id that happens to
  // parse as a gateway stored id is not special-cased: `request-plan.ts`
  // rewrites our stored ids away before the upstream call, so any stored-shaped
  // id echoed back is foreign (another gateway, or a checksum coincidence) and
  // gets its own fresh id like any other.
  const idMapper: ResponsesItemIdMapper = (upstreamId, itemType) => {
    let storedId = upstreamToStored.get(upstreamId);
    if (storedId === undefined) {
      storedId = createStoredResponsesItemId(itemType);
      upstreamToStored.set(upstreamId, storedId);
    }
    return storedId;
  };

  // Opportunistic and read-after-write: the insert is awaited so a caller that
  // has exposed the stored id can reference the row, but its failure is logged
  // and swallowed so storage never sinks an already-billable response.
  const insertStoredItems = async (rows: readonly StoredResponsesItem[]): Promise<void> => {
    if (rows.length === 0) return;
    try {
      await getRepo().responsesItems.insertMany(rows);
    } catch (error) {
      console.error('Failed to persist stored Responses items:', error);
    }
  };

  const buffer: StoredResponsesItem[] = [];
  const onItemFinalized: ResponsesItemFinalizedHandler = async (originalItem, newId) => {
    const row = await buildRow(newId, originalItem, context, request);
    if (wantsStream) await insertStoredItems([row]);
    else buffer.push(row);
  };

  const commit: ResponsesItemsCommit = () => insertStoredItems(buffer);

  return { events: view.streamMapIdAsResponsesItems(frames, idMapper, onItemFinalized), commit };
};

const buildRow = async (
  newId: string,
  originalItem: ResponseInputItem,
  context: StoreResponsesContext,
  request: RequestContext,
): Promise<StoredResponsesItem> => {
  const upstreamId = (originalItem as { id?: unknown }).id;
  if (typeof upstreamId !== 'string' || upstreamId.length === 0) {
    throw new Error(`Cannot persist Responses item without an upstream id (newId=${newId}, type=${originalItem.type})`);
  }
  const upstreamOwned = context.targetApi === 'responses';
  const encryptedContent = responsesItemEncryptedContent(originalItem);
  return {
    id: newId,
    apiKeyId: request.apiKeyId ?? null,
    upstreamId: upstreamOwned ? context.upstream : null,
    upstreamItemId: upstreamOwned ? upstreamId : null,
    itemType: originalItem.type,
    payload: context.store === false ? null : { item: originalItem },
    encryptedContentHash: encryptedContent === null ? null : await hashResponsesItemEncryptedContent(encryptedContent),
    createdAt: Date.now(),
  };
};
