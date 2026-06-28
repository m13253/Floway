import { listModelProviders, resolveInterpretationsAcrossProviders } from './registry.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelKind } from '@floway-dev/protocols/common';
import type { ModelCandidate } from '@floway-dev/provider';

export type { ModelCandidate };

// Per-request model resolution. See RESOLUTION.md for the pipeline
// spec; this function is its single entry point for every data-plane
// endpoint. `sawModel=true` with empty `candidates` distinguishes
// "right id, wrong kind" (400) from "unknown id" (404, sawModel=false).
export const enumerateModelCandidates = async ({
  upstreamIds, model, kind, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  kind: ModelKind;
  scheduler: BackgroundScheduler;
  currentColo: string;
}): Promise<{
  readonly candidates: readonly ModelCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
}> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);
  const { resolutions, failedUpstreams } = await resolveInterpretationsAcrossProviders(model, providers, fetcherForUpstream, scheduler);

  const candidates: ModelCandidate[] = [];
  let sawModel = false;
  for (const resolved of resolutions) {
    sawModel = true;
    if (resolved.model.kind !== kind) continue;
    candidates.push({ provider: resolved.provider, model: resolved.model, fetcher: fetcherForUpstream(resolved.provider.upstream) });
  }
  return { candidates, sawModel, failedUpstreams };
};
