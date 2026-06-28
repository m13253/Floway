import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { listModelProviders, resolveInterpretationsAcrossProviders } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Pairs a resolved candidate with the chat target protocol the calling
// serve picked for it. Chat dispatch operates on these pairs end-to-end:
// the planner reorders them by routing affinity, the attempt layer
// receives one and switches on `targetApi` to choose between the native
// wire call and a translation-shim path.
export interface ChatPlanItem {
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
}

// Returns every chat-kind candidate the resolver produced for the inbound
// id, plus a `sawModel` flag that distinguishes the "model is missing
// entirely" failure from "model exists but is the wrong kind for this
// source", plus the names of upstreams whose catalog fetch rejected this
// round so the caller's failure renderer can surface them parenthetically.
// The picker callback is the calling serve's responsibility; this layer
// stays kind-aware and endpoint-blind so the same resolution path is
// reusable across protocols and operations.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every chat serve.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{ readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  // The shared resolver expands each inbound id into (provider, lookupId)
  // interpretations across unprefixed and prefixed addressable surfaces,
  // runs the SWR-cached per-upstream lookup, and retries once with the
  // dated suffix stripped if the first pass found nothing. The chat path
  // then keeps only chat-kind entries; non-chat resolutions are visible
  // to `sawModel` (so the failure renderer can distinguish "model exists
  // but wrong kind" from "model missing entirely") but never reach the
  // candidate list.
  const { resolutions, failedUpstreams } = await resolveInterpretationsAcrossProviders(model, providers, fetcherForUpstream, scheduler);

  const candidates: ProviderCandidate[] = [];
  let sawModel = false;

  for (const { provider, resolved } of resolutions) {
    sawModel = true;
    if (resolved.model.kind !== 'chat') continue;
    candidates.push({ provider, model: resolved.model, fetcher: fetcherForUpstream(provider.upstream) });
  }

  return { candidates, sawModel, failedUpstreams };
};

// Map raw candidates to plan items by running each candidate's
// `model.endpoints` through the caller's inbound-protocol preference
// picker. Candidates whose endpoints don't satisfy any preference are
// dropped — they cannot serve the current operation, so dispatching to
// them would be a guaranteed failure. The picker's null return is the
// failover signal; we apply it ahead of the planner so a non-routable
// candidate never reaches affinity reordering.
export const planChatCandidates = (
  candidates: readonly ProviderCandidate[],
  pickTarget: (endpoints: ModelEndpoints) => ChatTargetApi | null,
): readonly ChatPlanItem[] => {
  const items: ChatPlanItem[] = [];
  for (const candidate of candidates) {
    const targetApi = pickTarget(candidate.model.endpoints);
    if (targetApi !== null) items.push({ candidate, targetApi });
  }
  return items;
};
