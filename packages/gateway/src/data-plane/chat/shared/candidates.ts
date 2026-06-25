import type { ModelAlias, ModelAliasRules } from '../../../control-plane/model-aliases/types.ts';
import { createPerRequestFetcher } from '../../../dial/per-request.ts';
import { collectInterpretationOutcomes, enumerateModelInterpretations, listModelProviders } from '../../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

export type { ProviderCandidate };

// Wrapper around `ProviderCandidate` that carries the matched alias's
// operator-locked request-time rules and the alias name. The wrapper lives
// here (in the gateway) rather than on `ProviderCandidate` itself to keep
// the `@floway-dev/provider` package unaware of the gateway's alias
// concept. Downstream attempt logic narrows the candidate when it needs
// to apply rules or stamp the `x-floway-alias` response header; passthrough
// consumers continue to treat the candidate as a plain `ProviderCandidate`.
export type ChatCandidate = ProviderCandidate & {
  readonly aliasRules?: ModelAliasRules;
  readonly aliasName?: string;
};

// Returns the candidates that satisfy both the model resolution and the
// target-endpoint pick, plus a `sawModel` flag that distinguishes the
// "model is missing entirely" failure from "model exists but does not
// expose the endpoint this source needs", plus the names of upstreams
// whose catalog fetch rejected this round so the caller's failure
// renderer can surface them parenthetically.
export const enumerateProviderCandidates = async ({
  upstreamIds, model, aliases, pickTarget, scheduler, currentColo,
}: {
  // null = unrestricted; empty list = no providers visible.
  upstreamIds: readonly string[] | null;
  model: string;
  // Operator-managed alias table loaded by the caller (typically via
  // `getRepo().modelAliases.loadAll()`). The fan-out matches each
  // (provider, lookupId) interpretation against this list; an empty list
  // is a valid input and produces only literal interpretations.
  aliases: readonly ModelAlias[];
  pickTarget: (endpoints: ModelEndpoints) => ChatTargetApi | null;
  // Threaded into `resolveModelForProvider` so the per-upstream catalog
  // lookup hits the SWR-cached `fetchUpstreamModelsCached` instead of
  // round-tripping to the upstream on every chat serve.
  scheduler: BackgroundScheduler;
  // Current colo for this request — see GatewayCtx.currentColo. Threaded
  // into the per-request fetcher so colo-scoped fallback entries can be
  // honoured at dial time.
  currentColo: string;
}): Promise<{ readonly candidates: readonly ChatCandidate[]; readonly sawModel: boolean; readonly failedUpstreams: readonly string[] }> => {
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);

  // Each (provider, lookupId) interpretation describes one way the inbound
  // id can address an upstream — bare form for `[unprefixed]`-addressable
  // upstreams, stripped form for `[prefixed]`-addressable upstreams when the
  // inbound starts with the configured prefix. A dual-addressable upstream
  // contributes both when applicable. The fan-out is shared with
  // `resolveModelForRequest`; first-viable-wins ordering follows configured
  // sort_order across upstreams, with the unprefixed interpretation pushed
  // before the prefixed one within a single upstream.
  //
  // Alias matching runs inside `enumerateModelInterpretations`: each
  // (provider, lookupId) pair is checked against the alias table and the
  // matched alias's `onConflict` decides what to push. The alias-rewrite
  // metadata rides out alongside each resolved candidate so the attempt
  // layer can apply the locked rules.
  const interpretations = enumerateModelInterpretations(model, providers, aliases);
  const { resolutions, failedUpstreams } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);

  const candidates: ChatCandidate[] = [];
  let sawModel = false;

  for (const { interpretation, provider, resolved } of resolutions) {
    sawModel = true;
    const targetApi = pickTarget(resolved.binding.upstreamModel.endpoints);
    if (!targetApi) continue;
    const base: ProviderCandidate = { provider, binding: resolved.binding, targetApi, fetcher: fetcherForUpstream(provider.upstream) };
    candidates.push(
      interpretation.aliasRules !== undefined
        ? { ...base, aliasRules: interpretation.aliasRules, aliasName: interpretation.aliasName }
        : base,
    );
  }

  return { candidates, sawModel, failedUpstreams };
};
