import { listModelProviders, resolveInterpretationsAcrossProviders } from './registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Per-request model resolution: resolve the inbound id against every
// upstream the caller's scope allows, retry once with an `-YYYYMMDD`
// suffix stripped, then keep only resolutions whose model.kind matches
// the inbound endpoint family. Each surviving resolution becomes a
// `(provider, model, fetcher)` candidate the dispatch layer can call.
//
// `sawModel` is true whenever the inbound id resolved against at least
// one upstream catalog, regardless of kind. Callers use it to
// distinguish "model id is unknown to every configured upstream"
// (sawModel=false) from "model exists but is the wrong kind for this
// endpoint" (sawModel=true, candidates=[]).
//
// Endpoint-level narrowing — picking the chat target protocol from
// `model.endpoints`, or checking the specific `imagesEdits` /
// `imagesGenerations` / `completions` endpoint key — is the caller's
// job. This function stays endpoint-blind so the same path serves
// chat, embeddings, image generation/edits, and legacy completions.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, kind, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  kind: ModelKind;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every request.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{
  readonly candidates: readonly ProviderCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);
  const { resolutions, failedUpstreams } = await resolveInterpretationsAcrossProviders(model, providers, fetcherForUpstream, scheduler);

  const candidates: ProviderCandidate[] = [];
  let sawModel = false;
  for (const resolved of resolutions) {
    sawModel = true;
    if (resolved.model.kind !== kind) continue;
    candidates.push({ provider: resolved.provider, model: resolved.model, fetcher: fetcherForUpstream(resolved.provider.upstream) });
  }
  return { candidates, sawModel, failedUpstreams };
};
