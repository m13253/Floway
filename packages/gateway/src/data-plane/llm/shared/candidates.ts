import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { enumerateModelInterpretations, listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { LlmTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes the
// "model is missing entirely" failure from "model exists but does not
// expose the endpoint this source needs", plus the names of upstreams
// whose catalog fetch rejected this round so the caller's failure
// renderer can surface them parenthetically.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, pickTarget, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  pickTarget: (endpoints: ModelEndpoints) => LlmTargetApi | null;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every LLM serve.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{ readonly candidates: readonly ProviderCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  // Each (provider, lookupId) interpretation describes one way the inbound
  // id can address an upstream — bare form for `[unprefixed]`-addressable
  // upstreams, stripped form for `[prefixed]`-addressable upstreams when the
  // inbound starts with the configured prefix. A dual-addressable upstream
  // contributes both when applicable.
  const interpretations = enumerateModelInterpretations(model, providers);

  // Fan out per-interpretation and recover each rejection as a "this
  // upstream has no models for this request" result rather than propagating
  // the first failure: one upstream past HARD whose force re-fetch fails
  // must not poison routing for other upstreams. The cache layer already
  // memoizes in-flight fetches per upstream so the parallel walk does not
  // multiply upstream round trips. Results are kept in input order so
  // candidate priority (first viable candidate wins) matches the configured
  // provider order, with the unprefixed interpretation preceding the
  // prefixed one within a dual-addressable upstream.
  const settled = await Promise.allSettled(interpretations.map(({ provider, lookupId }) =>
    resolveModelForProvider(provider, lookupId, fetcherForUpstream(provider.upstream), scheduler)
      .then(resolved => ({ provider, resolved }))));

  const candidates: ProviderCandidate[] = [];
  const failedUpstreams: string[] = [];
  const failedSeen = new Set<string>();
  let sawModel = false;

  for (const [index, result] of settled.entries()) {
    const provider = interpretations[index].provider;
    if (result.status === 'rejected') {
      const error = result.reason;
      // Caller-driven cancellation must propagate — do not bury it in
      // `failedUpstreams`.
      if (error instanceof Error && error.name === 'AbortError') throw error;
      // A single upstream may produce multiple interpretations; surface its
      // failure once.
      if (!failedSeen.has(provider.name)) {
        failedSeen.add(provider.name);
        failedUpstreams.push(provider.name);
      }
      continue;
    }

    const { resolved } = result.value;
    if (!resolved) continue;
    sawModel = true;

    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;

    candidates.push({ provider, binding: resolved.binding, targetApi, fetcher: fetcherForUpstream(provider.upstream) });
  }

  return { candidates, sawModel, failedUpstreams };
};
