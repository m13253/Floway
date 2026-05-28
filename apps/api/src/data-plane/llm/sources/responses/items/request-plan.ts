import {
  createStoredResponsesItemNotFoundDiagnostic,
  createStoredResponsesRoutingUnavailableDiagnostic,
  throwStoredResponsesItemsDiagnostic,
  type StoredResponsesItemsDiagnostic,
} from './errors.ts';
import { createTemporaryResponsesItemId, isKnownResponsesItemType, parseStoredResponsesItemId } from './format.ts';
import { getRepo } from '../../../../../repo/index.ts';
import type { StoredResponsesItem } from '../../../../../repo/types.ts';
import type { ModelProviderInstance, ProviderModelRecord } from '../../../../providers/types.ts';
import type { ResponseInputItem } from '@floway-dev/protocols/responses';
import type { ResponsesItemMapper, ResponsesItemVisitor } from '@floway-dev/translate/via-responses/responses-items';

export interface StoredResponsesItemsSourceAdapter<TSourceItems, TMappedSourceItems = TSourceItems> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<TMappedSourceItems>;
}

export type StoredResponsesUseSiteAffinity = 'forcing' | 'portable' | 'downgradable' | 'non_affinity';

export interface StoredResponsesUseSite {
  id: string;
  item: ResponseInputItem;
  sourceItemType: string;
  lookup: boolean;
  row?: StoredResponsesItem;
  affinity?: StoredResponsesUseSiteAffinity;
  order: number;
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

export const prepareStoredResponsesItemsForSource = async <TSourceItems>(
  sourceItems: TSourceItems,
  apiKeyId: string | null,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems>,
): Promise<PreparedStoredResponsesItems> => {
  const useSites = await collectStoredResponsesUseSites(sourceItems, sourceAdapter);
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
    if (!isKnownResponsesItemType(row.itemType)) {
      throw new Error(`Stored Responses item '${row.id}' has unknown item type '${row.itemType}'.`);
    }

    if (site.item.type === 'item_reference' && row.payload === null && row.upstreamItemId === null) {
      diagnostics.push(createStoredResponsesItemNotFoundDiagnostic(row.id));
      continue;
    }

    if (site.item.type !== 'item_reference' && site.sourceItemType !== row.itemType) {
      diagnostics.push(createStoredResponsesRoutingUnavailableDiagnostic(
        `Stored Responses item '${row.id}' has type '${row.itemType}', incompatible with the requested item type '${site.sourceItemType}'.`,
      ));
      continue;
    }

    site.affinity = classifyStoredResponsesUseSite(site.item, row);
    if (site.affinity === 'forcing' && !row.upstreamId) {
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
  const preferred = [...preferredUpstreamsByReverseLastOccurrence(prepared)];
  if (preferred.length === 0) return providers;

  const order = new Map(preferred.map((upstreamId, index) => [upstreamId, index]));
  const preferredProviders = providers
    .filter(provider => order.has(provider.upstream))
    .toSorted((a, b) => order.get(a.upstream)! - order.get(b.upstream)!);
  const remainingProviders = providers.filter(provider => !order.has(provider.upstream));
  return [...preferredProviders, ...remainingProviders];
};

export async function applyPreRoutingExpansions<TSourceItems, TMappedSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems, TMappedSourceItems>,
): Promise<TMappedSourceItems>;
export async function applyPreRoutingExpansions<TSourceItems, TMappedSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems, TMappedSourceItems>,
): Promise<TMappedSourceItems> {
  throwForPreparedDiagnostics(prepared);
  return await sourceAdapter.mapAsResponsesItems(sourceItems, item => {
    const id = responsesItemId(item);
    if (id === null || !parseStoredResponsesItemId(id)) return item;
    const row = prepared.rows.get(id);
    if (row?.payload === null || row === undefined) return item;
    return storedItemReplacementBase(item, row);
  });
}

export async function rewriteStoredResponsesItemsForProvider<TSourceItems, TMappedSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  provider: ProviderModelRecord,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems, TMappedSourceItems>,
): Promise<TMappedSourceItems>;
export async function rewriteStoredResponsesItemsForProvider<TSourceItems, TMappedSourceItems>(
  sourceItems: TSourceItems,
  prepared: PreparedStoredResponsesItems,
  provider: ProviderModelRecord,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems, TMappedSourceItems>,
): Promise<TMappedSourceItems> {
  throwForPreparedDiagnostics(prepared);
  return await sourceAdapter.mapAsResponsesItems(sourceItems, item => rewriteStoredResponsesItemForProvider(item, prepared, provider));
}

const collectStoredResponsesUseSites = async <TSourceItems>(
  sourceItems: TSourceItems,
  sourceAdapter: StoredResponsesItemsSourceAdapter<TSourceItems>,
): Promise<StoredResponsesUseSite[]> => {
  const useSites: StoredResponsesUseSite[] = [];
  let order = 0;

  await sourceAdapter.visitAsResponsesItems(sourceItems, item => {
    const id = responsesItemId(item);
    if (id === null) return;

    if (parseStoredResponsesItemId(id)) {
      useSites.push({
        id,
        item: structuredClone(item),
        sourceItemType: item.type,
        lookup: true,
        order,
      });
      order += 1;
      return;
    }

    if (item.type === 'item_reference') {
      useSites.push({
        id,
        item: structuredClone(item),
        sourceItemType: item.type,
        lookup: false,
        order,
      });
      order += 1;
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
    if (!preferredIds.has(id) || !row.upstreamId) continue;
    preferred.delete(row.upstreamId);
    preferred.add(row.upstreamId);
  }

  return preferred;
};

const preferredUpstreamsByReverseLastOccurrence = (
  prepared: PreparedStoredResponsesItems,
): readonly string[] => [...prepared.preferredUpstreamIds].reverse();

const findUnexpandedItemReferenceForcingId = (
  prepared: PreparedStoredResponsesItems,
  upstreamId: string,
): string | null =>
  prepared.useSites.find(site =>
    site.affinity === 'forcing'
    && site.item.type === 'item_reference'
    && site.row?.upstreamId === upstreamId
    && site.row.payload === null)?.id ?? null;

const classifyStoredResponsesUseSite = (
  item: ResponseInputItem,
  row: StoredResponsesItem,
): StoredResponsesUseSiteAffinity => {
  if (item.type === 'item_reference' && row.payload === null) return 'forcing';
  if (!row.upstreamId) return 'non_affinity';
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
  if (!isKnownResponsesItemType(row.itemType)) throw new Error(`Stored Responses item '${row.id}' has unknown item type '${row.itemType}'.`);
  if (item.type !== 'item_reference' && item.type !== row.itemType) {
    throwStoredResponsesItemsDiagnostic(createStoredResponsesRoutingUnavailableDiagnostic(
      `Stored Responses item '${row.id}' has type '${row.itemType}', incompatible with the requested item type '${item.type}'.`,
    ));
  }

  const affinity = classifyStoredResponsesUseSite(item, row);
  if (affinity === 'forcing' && row.upstreamId !== provider.upstream) {
    throwStoredResponsesItemsDiagnostic(createStoredResponsesRoutingUnavailableDiagnostic(
      `Stored Responses item '${row.id}' requires upstream '${row.upstreamId ?? provider.upstream}', which is not the selected upstream.`,
    ));
  }
  if (item.type === 'item_reference' && row.payload === null && !provider.supportsResponsesItemReference) {
    throwStoredResponsesItemsDiagnostic(createStoredResponsesItemNotFoundDiagnostic(row.id));
  }

  if (row.itemType === 'reasoning' && row.upstreamId !== provider.upstream) return null;
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
  if (row.payload === null) return structuredClone(item);
  const replacement = structuredClone(row.payload.item) as ResponseInputItem;
  if (!isKnownResponsesItemType(replacement.type)) throw new Error(`Stored Responses item '${row.id}' payload has unknown item type '${replacement.type}'.`);
  return replacement;
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
