import { createTemporaryResponsesItemId, hashResponsesItemEncryptedContent, responsesItemEncryptedContent, responsesItemId } from './format.ts';
import { throwLlmServeFailure } from '../../shared/errors.ts';
import type { StatefulResponsesStore } from './store.ts';
import type { StoredResponsesItem } from '../../../../repo/types.ts';
import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { ResponsesInputItem, ResponsesPayload } from '@floway-dev/protocols/responses';

const isUpstreamOwned = (row: StoredResponsesItem): row is StoredResponsesItem & { upstreamId: string } =>
  row.upstreamId !== null;

const storedItemReplacementBase = (
  item: ResponsesInputItem,
  row: StoredResponsesItem,
): ResponsesInputItem => {
  if (row.payload === null) return item;
  return structuredClone(row.payload.item) as ResponsesInputItem;
};

const itemWithId = (item: ResponsesInputItem, id: string): ResponsesInputItem => ({
  ...item,
  id,
} as ResponsesInputItem);

const rewriteItemForCandidate = (
  item: ResponsesInputItem,
  row: StoredResponsesItem,
  candidate: ProviderCandidate,
): ResponsesInputItem | null => {
  // An `item_reference` whose stored row has no inline payload can only
  // travel as a reference on the wire; a provider that doesn't support
  // `item_reference` input has no way to expand it.
  if (item.type === 'item_reference' && row.payload === null && !candidate.binding.supportsResponsesItemReference) {
    throwLlmServeFailure({ kind: 'item-not-found', itemId: row.id });
  }

  if (!isUpstreamOwned(row)) {
    // Synthetic rows have no owning upstream and stay portable to any
    // provider. Inline-expand from the stored payload and preserve
    // `payload.item.id` verbatim so the wire id matches what the per-attempt
    // `privatePayload` seed reads — source interceptors look the payload up
    // by whatever id the rewriter puts on the wire, no rewriter-side stash.
    return storedItemReplacementBase(item, row);
  }

  // Owned reasoning is bound to the upstream that produced it; drop it when
  // routing elsewhere.
  if (row.itemType === 'reasoning' && row.upstreamId !== candidate.binding.upstream) return null;

  if (row.upstreamId === candidate.binding.upstream && row.upstreamItemId) {
    // Same upstream: substitute the original upstream-issued id. A
    // reference-capable provider keeps the wire item as `item_reference`;
    // others inline-expand against the stored payload.
    return item.type === 'item_reference' && candidate.binding.supportsResponsesItemReference
      ? itemWithId(item, row.upstreamItemId)
      : itemWithId(storedItemReplacementBase(item, row), row.upstreamItemId);
  }

  // Cross-upstream owned: mint a tmp id so the foreign upstream's id
  // namespace can't bleed into the new upstream's view.
  const replacement = storedItemReplacementBase(item, row);
  if (responsesItemId(replacement) !== null) return itemWithId(replacement, createTemporaryResponsesItemId(row.itemType));
  return replacement;
};

export const rewriteResponsesItemsForCandidate = async (
  payload: ResponsesPayload,
  store: StatefulResponsesStore,
  candidate: ProviderCandidate,
): Promise<ResponsesPayload> => {
  if (typeof payload.input === 'string') return payload;

  // Pre-compute encrypted_content hashes so each item lookup is a single
  // synchronous map access rather than a fresh hash per item.
  const encryptedContents = [...new Set(
    payload.input.flatMap(item => {
      const enc = responsesItemEncryptedContent(item);
      return enc !== null ? [enc] : [];
    }),
  )];
  const hashByEncryptedContent = new Map(
    await Promise.all(encryptedContents.map(async enc => [enc, await hashResponsesItemEncryptedContent(enc)] as const)),
  );

  const rewritten: ResponsesInputItem[] = [];
  for (const item of payload.input) {
    const id = responsesItemId(item);
    const encryptedContent = responsesItemEncryptedContent(item);
    const row = (id !== null ? store.getItemById(id) : undefined)
      ?? (encryptedContent !== null ? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!).find(
        r => item.type === 'item_reference' || r.itemType === item.type,
      ) ?? store.getItemsByEncryptedContentHash(hashByEncryptedContent.get(encryptedContent)!)[0] : undefined);

    if (row === undefined) {
      rewritten.push(item);
      continue;
    }

    const result = rewriteItemForCandidate(item, row, candidate);
    if (result !== null) rewritten.push(result);
  }

  return { ...payload, input: rewritten };
};
