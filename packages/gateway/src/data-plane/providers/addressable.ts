// One enumeration per (effective upstream cap) of every inbound model id the
// gateway accepts — the union of the listed catalog surface and the
// addressable-but-not-listed surface contributed by `modelPrefix.addressable`
// alternates and by each provider's `resolveRequestedModelId` redirect map.
//
// Why this exists: the listing-side availability check (alias-listing,
// codex catalog) used strict literal id equality against the listed catalog,
// while the request-time resolver routes through `enumerateModelInterpretations`
// + `resolveRequestedModelId`. A target that the resolver accepts via a
// prefix-variant or Copilot variant collapse therefore looked "unavailable"
// to the listing. Recomputing the resolver-accepted surface against the
// listed catalog gives every consumer one consistent answer.
//
// Each entry carries the `ResolvedModel` the addressable id will route to,
// so consumers (alias intersection, codex catalog, control-plane DTO) can
// read `limits` / `chat` / `endpoints` directly off the entry without a
// second registry round trip.

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

export interface AddressableSurface {
  readonly entries: readonly AddressableIdEntry[];
}

// Enumerate every inbound id the data plane accepts under `upstreamFilter`,
// tagged with whether the id participates in the default `/v1/models`
// listing. Fans out per upstream the same way `collectProviderModels` does,
// re-uses the SWR cache so the catalog refresh round-trip is shared with
// `getModels`.
export const enumerateAddressableModelIds = async (
  upstreamFilter: readonly string[] | null,
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<AddressableSurface> => {
  const providers = await listModelProviders(upstreamFilter);
  if (providers.length === 0) return { entries: [] };

  // The canonical listed surface — the same rows the existing /v1/models
  // and /api/models endpoints emit. Forms the listed half of the
  // addressable surface.
  const realModels = await getModels(upstreamFilter, fetcherForUpstream, scheduler);
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
  for (const provider of providers) {
    const cfg = provider.modelPrefix;
    const addressableOnly = cfg !== null ? cfg.addressable.filter(form => !cfg.listed.includes(form)) : [];
    if (addressableOnly.length === 0 && provider.enumerateAddressableRedirects === undefined) continue;

    const upstreamModels = await fetchUpstreamModelsCached(provider, { scheduler, fetcher: fetcherForUpstream(provider.upstream) });
    const disabled = new Set(provider.disabledPublicModelIds);

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
          push({ id, unlisted: true, model: canonical });
        }
      }
    }

    const redirects = provider.enumerateAddressableRedirects?.({ upstreamModels }) ?? [];
    for (const redirect of redirects) {
      const target = byId.get(redirect.resolvesTo);
      if (target === undefined) continue;
      push({ id: redirect.addressable, unlisted: true, model: target });
    }
  }

  // Stable id ordering matches the listed surface so consumers can rely on
  // a single comparator across both halves.
  return { entries: entries.sort((a, b) => compareModelIds(a.id, b.id)) };
};
