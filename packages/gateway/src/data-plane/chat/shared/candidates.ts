import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { getRepo } from '../../../repo/index.ts';
import { type AliasResolution, resolveAlias } from '../../model-aliases/resolve.ts';
import { collectInterpretationOutcomes, enumerateModelInterpretations, listModelProviders } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

export type ChatCandidate = ProviderCandidate;

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes the
// "model is missing entirely" failure from "model exists but does not
// expose the endpoint this source needs", plus the names of upstreams
// whose catalog fetch rejected this round so the caller's failure
// renderer can surface them parenthetically. See resolve.ts for the
// alias-resolves-once-above-prefix-routing contract; this entry runs it
// and returns the resolution on `aliasResolution`.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, pickTarget, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  pickTarget: (endpoints: ModelEndpoints) => ChatTargetApi | null;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every chat serve.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{
  readonly candidates: readonly ChatCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
  readonly aliasResolution: AliasResolution | null;
}> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  // See resolve.ts for the alias-resolves-once-above-prefix-routing contract.
  // The endpoint predicate piggybacks on `pickTarget` so the resolver's pool
  // narrows to targets whose binding exposes one of the chat surfaces the
  // source serve actually wants.
  const aliasResolution = await resolveAlias({
    modelName: model,
    providers,
    fetcherForUpstream,
    scheduler,
    endpointAccepts: endpoints => pickTarget(endpoints) !== null,
    repo: getRepo().modelAliases,
  });
  const effectiveModel = aliasResolution?.targetModelId ?? model;

  // Each (provider, lookupId) interpretation describes one way the inbound
  // id can address an upstream — bare form for `[unprefixed]`-addressable
  // upstreams, stripped form for `[prefixed]`-addressable upstreams when the
  // inbound starts with the configured prefix. A dual-addressable upstream
  // contributes both when applicable. The fan-out is shared with
  // `resolveModelForRequest`; first-viable-wins ordering follows configured
  // sort_order across upstreams, with the unprefixed interpretation pushed
  // before the prefixed one within a single upstream.
  const interpretations = enumerateModelInterpretations(effectiveModel, providers);
  const { resolutions, failedUpstreams } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);

  const candidates: ChatCandidate[] = [];
  let sawModel = false;

  for (const { provider, resolved } of resolutions) {
    sawModel = true;
    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;
    candidates.push({ provider, binding: resolved.binding, targetApi, fetcher: fetcherForUpstream(provider.upstream) });
  }

  return {
    candidates,
    sawModel,
    failedUpstreams,
    aliasResolution,
  };
};
