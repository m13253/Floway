// One enumeration per (effective upstream cap) of every inbound model id the
// gateway accepts — the union of the listed catalog surface and the
// addressable-but-not-listed surface contributed by `modelPrefix.addressable`
// alternates and by each provider's `resolveRequestedModelId` redirect map.
// Listing-side availability checks (alias-listing, codex catalog) must see
// the same set the request-time resolver routes through
// (`enumerateModelInterpretations` + `resolveRequestedModelId`); recomputing
// it once here gives every consumer one consistent answer.
//
// Each entry carries the `ResolvedModel` the addressable id will route to,
// so consumers (alias intersection, codex catalog, control-plane DTO) read
// `limits` / `chat` / `endpoints` directly off the entry without a second
// registry round trip.

import { fetchUpstreamModelsCached } from './models-cache.ts';
import { compareModelIds, getModels, listModelProviders } from './registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { Fetcher, ResolvedModel } from '@floway-dev/provider';

export interface AddressableIdEntry {
  // The inbound model id the data plane will accept verbatim.
  readonly id: string;
  // Absent on default-listed entries (the public-id surface the listing
  // already emits); present-and-`true` on entries that are only reachable
  // through `modelPrefix.addressable` alternates or provider-side redirects.
  // The negative carry pairs with the `PublicModel.unlisted?: true` wire
  // shape so a listed entry's wire bytes stay byte-identical.
  readonly unlisted: true | undefined;
  // Real catalog row this id routes to. For multi-provider models this is
  // the same `ResolvedModel` instance `getModels` returns (one row per
  // public-listed id, with the union-merged endpoints + `providers[]`
  // already applied).
  readonly model: ResolvedModel;
}

// Project the listed (real-catalog) `ResolvedModel`s out of an addressable
// surface — every listing caller wants this same slice to feed
// `mergeAliasesIntoModels`'s `realModels` arg.
export const listedRealModels = (entries: readonly AddressableIdEntry[]): readonly ResolvedModel[] =>
  entries.filter(entry => entry.unlisted === undefined).map(entry => entry.model);

// Enumerate every inbound id the data plane accepts under `upstreamFilter`,
// tagged with whether the id participates in the default `/v1/models`
// listing. Fans out per upstream the same way `collectProviderModels` does,
// re-uses the SWR cache so the catalog refresh round-trip is shared with
// `getModels`.
export const enumerateAddressableModelIds = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<readonly AddressableIdEntry[]> => {
  // `getModels` throws the actionable "no upstream provider configured"
  // message when the provider list is empty; surface it the same way here
  // so /v1/models keeps its 502 + hint behavior on a brand-new gateway.
  const realModels = await getModels(upstreamFilter, fetcherForUpstream, scheduler);
  const providers = await listModelProviders(upstreamFilter);
  const byId = new Map(realModels.map(model => [model.id, model] as const));

  const entries: AddressableIdEntry[] = [];
  const seen = new Set<string>();
  const push = (entry: AddressableIdEntry): void => {
    if (seen.has(entry.id)) return;
    seen.add(entry.id);
    entries.push(entry);
  };

  for (const model of realModels) {
    push({ id: model.id, unlisted: undefined, model });
  }

  // Per-upstream walk: (a) prefix-addressable alternates the listed surface
  // chose not to publish, then (b) the provider's redirect enumeration. The
  // catalog round-trip is the same SWR cache the listed surface just
  // consumed, so this loop never pays a second upstream hit.
  //
  // A rejected per-upstream catalog refresh collapses to no addressable-only
  // contribution from THAT upstream — its listed rows already came (or were
  // dropped) through `getModels`. Mirrors the `Promise.allSettled` tolerance
  // there so a transiently-down upstream cannot tank /v1/models on a
  // cold-start gateway.
  const perUpstream = await Promise.allSettled(providers.map(async provider => {
    const cfg = provider.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (addressableOnly.length === 0 && provider.enumerateAddressableRedirects === undefined) {
      return [] as AddressableIdEntry[];
    }

    const upstreamModels = await fetchUpstreamModelsCached(provider, { scheduler, fetcher: fetcherForUpstream(provider.upstream) });
    const disabled = new Set(provider.disabledPublicModelIds);
    const out: AddressableIdEntry[] = [];

    if (cfg !== null && addressableOnly.length > 0) {
      // The canonical listed form for this upstream — the row the listing
      // surface emitted, and the row a redirect-only addressable id should
      // resolve back into so consumers find one consistent `ResolvedModel`.
      const canonicalForm = cfg.listed.includes('prefixed') ? 'prefixed' : 'unprefixed';

      for (const upstreamModel of upstreamModels) {
        if (!upstreamModel.id || disabled.has(upstreamModel.id)) continue;
        const canonicalPublicId = canonicalForm === 'prefixed'
          ? `${cfg.prefix}${upstreamModel.id}`
          : upstreamModel.id;
        const canonical = byId.get(canonicalPublicId);
        if (canonical === undefined) continue;
        for (const form of addressableOnly) {
          const id = form === 'prefixed' ? `${cfg.prefix}${upstreamModel.id}` : upstreamModel.id;
          out.push({ id, unlisted: true, model: canonical });
        }
      }
    }

    const redirects = provider.enumerateAddressableRedirects?.({ upstreamModels }) ?? [];
    for (const redirect of redirects) {
      const target = byId.get(redirect.resolvesTo);
      if (target === undefined) continue;
      out.push({ id: redirect.addressable, unlisted: true, model: target });
    }
    return out;
  }));

  for (const result of perUpstream) {
    if (result.status === 'rejected') {
      // Cancellation must propagate even from this tolerant fanout — the
      // per-request abort signal cannot be masked by an upstream's slow
      // rejection. Other failures (catalog 5xx, parse, transport) collapse
      // to no addressable-only contribution from that upstream per the
      // contract above.
      if (result.reason instanceof Error && result.reason.name === 'AbortError') throw result.reason;
      continue;
    }
    for (const entry of result.value) push(entry);
  }

  // Stable id ordering matches the listed surface so consumers can rely on
  // a single comparator across both halves.
  return entries.sort((a, b) => compareModelIds(a.id, b.id));
};
