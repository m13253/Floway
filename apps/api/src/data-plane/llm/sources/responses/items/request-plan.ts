import {
  createStoredResponsesItemNotFoundDiagnostic,
  createStoredResponsesRoutingUnavailableDiagnostic,
  throwStoredResponsesItemsDiagnostic,
  type StoredResponsesItemsDiagnostic,
} from './errors.ts';
import { createTemporaryResponsesItemId, parseStoredResponsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type { Mutable, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

export type StoredResponsesUseSiteAffinity = 'forcing' | 'portable' | 'downgradable' | 'non_affinity';

export interface StoredResponsesUseSite {
  id: string;
  type: string;
  lookup: boolean;
  row?: StoredResponsesItem;
  affinity?: StoredResponsesUseSiteAffinity;
}

export interface PreparedStoredResponsesItems {
  rows: Map<string, StoredResponsesItem>;
  useSites: StoredResponsesUseSite[];
  diagnostics: StoredResponsesItemsDiagnostic[];
  forcingUpstreamIds: ReadonlySet<string>;
  preferredUpstreamIds: ReadonlySet<string>;
}

export type StoredResponsesProviderPlan =
  | { type: 'providers'; providers: readonly ModelProviderInstance[] }
  | { type: 'error'; diagnostic: StoredResponsesItemsDiagnostic };

// A stored row either belongs to the upstream that produced it — native
// Responses upstreams hand back their own item ids — or is gateway-synthesized
// from a non-Responses upstream, in which case it has no upstream identity.
// Owned rows carry routing affinity tied to their origin; synthetic rows are
// freely portable and inline-expanded to whichever upstream serves the request.
const isUpstreamOwned = (row: StoredResponsesItem): row is StoredResponsesItem & { upstreamId: string } => row.upstreamId !== null;

export const prepareStoredResponsesItemsForSource = async <TSourceItems>(
  sourceItems: TSourceItems,
  apiKeyId: string | null,
  view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>,
): Promise<PreparedStoredResponsesItems> => {
  const useSites = await collectStoredResponsesUseSites(sourceItems, view);
  const ids = useSites.filter(site => site.lookup).map(site => site.id);
  const rowsById = new Map((await getRepo().responsesItems.lookupMany(apiKeyId, ids)).map(row => [row.id, row]));
  const rows = new Map<string, StoredResponsesItem>();
  const diagnostics: StoredResponsesItemsDiagnostic[] = [];

  for (const site of useSites) {
    if (!site.lookup) {
      diagnostics.push(createStoredResponsesItemNotFoundDiagnostic(site.id));
      continue;
    }

    const row = rowsById.get(site.id);
    if (!row) {
      diagnostics.push(createStoredResponsesItemNotFoundDiagnostic(site.id));
      continue;
    }

    site.row = row;
    if (site.type === 'item_reference' && row.payload === null && row.upstreamItemId === null) {
      diagnostics.push(createStoredResponsesItemNotFoundDiagnostic(row.id));
      continue;
    }

    if (site.type !== 'item_reference' && site.type !== row.itemType) {
      diagnostics.push(createStoredResponsesRoutingUnavailableDiagnostic(
        `Stored Responses item '${row.id}' has type '${row.itemType}', incompatible with the requested item type '${site.type}'.`,
      ));
      continue;
    }

    site.affinity = classifyStoredResponsesUseSite(site.type, row);
    if (site.affinity === 'forcing' && !isUpstreamOwned(row)) {
      diagnostics.push(createStoredResponsesItemNotFoundDiagnostic(row.id));
      continue;
    }
    rows.delete(row.id);
    rows.set(row.id, row);
  }

  const forcingUpstreamIds = collectUpstreamsForAffinities(useSites, new Set(['forcing']));
  const preferredUpstreamIds = collectPreferredUpstreams(rows, useSites);

  return {
    rows,
    useSites,
    diagnostics,
    forcingUpstreamIds,
    preferredUpstreamIds,
  };
};

export const planResponsesItemProviders = (
  providers: readonly ModelProviderInstance[],
  prepared: PreparedStoredResponsesItems,
): StoredResponsesProviderPlan => {
  if (prepared.diagnostics.length > 0) return { type: 'error', diagnostic: prepared.diagnostics[0] };

  const forcingUpstreamIds = [...prepared.forcingUpstreamIds];
  if (forcingUpstreamIds.length > 1) {
    return {
      type: 'error',
      diagnostic: createStoredResponsesRoutingUnavailableDiagnostic(
        `Stored Responses items in this request require multiple incompatible upstreams: ${forcingUpstreamIds.map(id => `'${id}'`).join(', ')}.`,
      ),
    };
  }

  if (forcingUpstreamIds.length === 1) {
    const [upstreamId] = forcingUpstreamIds;
    const matching = providers.filter(provider => provider.upstream === upstreamId);
    if (matching.length === 0) {
      return {
        type: 'error',
        diagnostic: createStoredResponsesRoutingUnavailableDiagnostic(
          `Stored Responses items in this request require upstream '${upstreamId}', which is not available for the selected model.`,
        ),
      };
    }
    const unexpandedReferenceId = findUnexpandedItemReferenceForcingId(prepared, upstreamId);
    if (unexpandedReferenceId !== null) {
      const itemReferenceCapable = matching.filter(provider => provider.supportsResponsesItemReference);
      if (itemReferenceCapable.length === 0) {
        return { type: 'error', diagnostic: createStoredResponsesItemNotFoundDiagnostic(unexpandedReferenceId) };
      }
      return { type: 'providers', providers: itemReferenceCapable };
    }
    return { type: 'providers', providers: matching };
  }

  return { type: 'providers', providers: orderProvidersByStoredResponsesAffinity(providers, prepared) };
};

export const orderProvidersByStoredResponsesAffinity = (
  providers: readonly ModelProviderInstance[],
  prepared: PreparedStoredResponsesItems,
): readonly ModelProviderInstance[] => {
  const preferred = [...prepared.preferredUpstreamIds].reverse();
  if (preferred.length === 0) return providers;

  const order = new Map(preferred.map((upstreamId, index) => [upstreamId, index]));
  const preferredProviders = providers
    .filter(provider => order.has(provider.upstream))
    .toSorted((a, b) => order.get(a.upstream)! - order.get(b.upstream)!);
  const remainingProviders = providers.filter(provider => !order.has(provider.upstream));
  return [...preferredProviders, ...remainingProviders];
};

export const rewriteStoredResponsesItemsForProvider = async <TSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  provider: ProviderModelRecord,
  view: ResponsesItemsView<TSourceItems>,
): Promise<Mutable<TSourceItems>> => {
  throwForPreparedDiagnostics(prepared);
  return await view.mapAsResponsesItems(sourceItems, item => rewriteStoredResponsesItemForProvider(item, prepared, provider));
};

// Non-item_reference items that arrive with an unparseable id are passed
// through as-is, never looked up. This is intentional: clients legitimately
// re-send items that were never stored (pre-feature ids, ids from a
// different gateway, opaque upstream ids). Only `item_reference` declares
// "this is a stored row" — everything else carries its own inline content.
const collectStoredResponsesUseSites = async <TSourceItems>(
  sourceItems: TSourceItems,
  view: Pick<ResponsesItemsView<TSourceItems>, 'visitAsResponsesItems'>,
): Promise<StoredResponsesUseSite[]> => {
  const useSites: StoredResponsesUseSite[] = [];

  await view.visitAsResponsesItems(sourceItems, item => {
    const id = responsesItemId(item);
    if (id === null) return;

    if (parseStoredResponsesItemId(id)) {
      useSites.push({ id, type: item.type, lookup: true });
      return;
    }

    if (item.type === 'item_reference') {
      useSites.push({ id, type: item.type, lookup: false });
    }
  });

  return useSites;
};

const collectUpstreamsForAffinities = (
  useSites: readonly StoredResponsesUseSite[],
  affinities: ReadonlySet<StoredResponsesUseSiteAffinity>,
): ReadonlySet<string> => {
  const upstreams = new Set<string>();
  for (const site of useSites) {
    if (!site.row?.upstreamId || !site.affinity || !affinities.has(site.affinity)) continue;
    upstreams.add(site.row.upstreamId);
  }
  return upstreams;
};

const collectPreferredUpstreams = (
  rows: ReadonlyMap<string, StoredResponsesItem>,
  useSites: readonly StoredResponsesUseSite[],
): ReadonlySet<string> => {
  const preferred = new Set<string>();
  const preferredIds = new Set(useSites
    .filter(site => site.affinity === 'portable' || site.affinity === 'downgradable')
    .map(site => site.id));

  for (const [id, row] of rows) {
    if (!preferredIds.has(id) || !isUpstreamOwned(row)) continue;
    preferred.delete(row.upstreamId);
    preferred.add(row.upstreamId);
  }

  return preferred;
};

const findUnexpandedItemReferenceForcingId = (
  prepared: PreparedStoredResponsesItems,
  upstreamId: string,
): string | null =>
  prepared.useSites.find(site =>
    site.affinity === 'forcing'
    && site.type === 'item_reference'
    && site.row?.upstreamId === upstreamId
    && site.row.payload === null)?.id ?? null;

const classifyStoredResponsesUseSite = (
  itemType: string,
  row: StoredResponsesItem,
): StoredResponsesUseSiteAffinity => {
  if (itemType === 'item_reference' && row.payload === null) return 'forcing';
  if (!isUpstreamOwned(row)) return 'non_affinity';
  if (row.itemType === 'compaction') return 'forcing';
  if (row.itemType === 'reasoning') return 'downgradable';
  return 'portable';
};

const rewriteStoredResponsesItemForProvider = (
  item: ResponseInputItem,
  prepared: PreparedStoredResponsesItems,
  provider: ProviderModelRecord,
): ResponseInputItem | null => {
  const id = responsesItemId(item);
  if (id === null || !parseStoredResponsesItemId(id)) return item;

  const row = prepared.rows.get(id) ?? throwStoredResponsesItemsDiagnostic(createStoredResponsesItemNotFoundDiagnostic(id));
  if (item.type === 'item_reference' && row.payload === null && !provider.supportsResponsesItemReference) {
    throwStoredResponsesItemsDiagnostic(createStoredResponsesItemNotFoundDiagnostic(row.id));
  }

  // Only upstream-owned reasoning is bound to the upstream that produced it and
  // must be dropped when routing elsewhere. Synthetic rows have no owner, carry
  // their full payload, and stay portable to any upstream regardless of type —
  // they fall through to inline expansion below.
  if (isUpstreamOwned(row) && row.itemType === 'reasoning' && row.upstreamId !== provider.upstream) return null;
  if (item.type === 'item_reference' && row.upstreamId === provider.upstream && row.upstreamItemId && provider.supportsResponsesItemReference) return itemWithId(item, row.upstreamItemId);

  const replacement = storedItemReplacementBase(item, row);
  if (row.upstreamId === provider.upstream && row.upstreamItemId) return itemWithId(replacement, row.upstreamItemId);
  if (hasResponsesItemId(replacement)) return itemWithId(replacement, createTemporaryResponsesItemId(row.itemType));
  return replacement;
};

const storedItemReplacementBase = (
  item: ResponseInputItem,
  row: StoredResponsesItem,
): ResponseInputItem => {
  // The caller hands us items it already owns (the per-attempt payload clone),
  // so the no-stored-payload branch may reuse `item` directly. The stored row,
  // by contrast, lives in the shared lookup cache and is cloned so downstream
  // interceptor mutation cannot corrupt it across the request.
  if (row.payload === null) return item;
  return structuredClone(row.payload.item) as ResponseInputItem;
};

const responsesItemId = (item: ResponseInputItem): string | null => {
  const id = (item as { id?: unknown }).id;
  return typeof id === 'string' ? id : null;
};

const hasResponsesItemId = (item: ResponseInputItem): boolean => responsesItemId(item) !== null;

const itemWithId = (item: ResponseInputItem, id: string): ResponseInputItem => ({
  ...item,
  id,
} as ResponseInputItem);

const throwForPreparedDiagnostics = (prepared: PreparedStoredResponsesItems): void => {
  const [diagnostic] = prepared.diagnostics;
  if (!diagnostic) return;

  throwStoredResponsesItemsDiagnostic(diagnostic);
};
