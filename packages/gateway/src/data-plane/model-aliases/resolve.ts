// Alias resolver. Runs once per request, above prefix routing. The target
// string it returns is fed verbatim back into the existing prefix-router
// (enumerateModelInterpretations → resolveModelForProvider); alias names
// never re-enter the alias layer, so recursion is impossible by
// construction and the shadow-the-real-model pattern (an alias whose first
// target is its own name) Just Works.
//
// The resolver is endpoint-aware on the pool-narrowing axis but
// kind-blind on the alias-rejection axis. The caller hands in an
// `endpointAccepts` predicate that decides whether a candidate target's
// resolved binding actually serves the inbound endpoint; the pool only
// keeps targets that satisfy it, so first-available / random pick from a
// set that the prefix router can serve end-to-end. The resolver does NOT
// reject an alias just because its kind disagrees with the inbound
// endpoint — that responsibility stays with the predicate, and a
// kind-mismatched alias surfaces the natural "no target available" 404.

import type { ModelAliasesRepo, ModelAliasRecord } from '../../repo/types.ts';
import { collectInterpretationOutcomes, enumerateModelInterpretations } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { AliasRules, ModelEndpoints } from '@floway-dev/protocols/common';
import type { Fetcher, ModelProviderInstance } from '@floway-dev/provider';

export interface AliasResolution {
  readonly targetModelId: string;
  readonly rules: AliasRules;
  // Original alias name, for the `x-floway-alias` response header and dump
  // attribution.
  readonly aliasName: string;
}

// Canonical wording for the alias-no-target-available 404. Called only
// from inside the `AliasNoTargetAvailableError` constructor so wording
// changes land in one place; consumers read `error.message` directly.
const aliasNoTargetMessage = (params: { aliasName: string; targetCount: number }): string =>
  `alias '${params.aliasName}' has ${params.targetCount} target(s); none currently map to an enabled upstream binding`;

// Thrown when the alias name was found but no target currently resolves to
// an enabled upstream binding that serves the inbound endpoint. Caught at
// each protocol's serve seam and surfaced as a 404 in the protocol-specific
// error envelope.
export class AliasNoTargetAvailableError extends Error {
  readonly aliasName: string;

  constructor(aliasName: string, targetCount: number) {
    super(aliasNoTargetMessage({ aliasName, targetCount }));
    this.name = 'AliasNoTargetAvailableError';
    this.aliasName = aliasName;
  }
}

interface ResolveAliasArgs {
  readonly modelName: string;
  readonly scheduler: BackgroundScheduler;
  // The same per-request fetcher and provider list the surrounding model
  // resolver already built. Sharing them keeps the upstream-list + proxy-
  // factory cost paid once per request rather than twice.
  readonly providers: readonly ModelProviderInstance[];
  readonly fetcherForUpstream: (upstreamId: string) => Fetcher;
  // Predicate the caller supplies to narrow the pool to targets whose
  // resolved binding serves the inbound endpoint. Chat callers wrap
  // `pickTarget`; passthrough callers check the specific endpoint key.
  // A target enters the pool iff at least one of its resolved bindings
  // returns true here.
  readonly endpointAccepts: (endpoints: ModelEndpoints) => boolean;
  // Injected so tests can hand in a stub; the per-request ctx already owns
  // a concrete one via `getRepo().modelAliases`.
  readonly repo: ModelAliasesRepo;
}

// Reports true when the target id resolves to at least one enabled upstream
// binding whose endpoint map satisfies the inbound endpoint predicate.
// `random` selection in particular depends on this — without endpoint
// awareness, a randomly-picked target may not serve the inbound endpoint
// and the request would 404 at prefix routing even though another target
// would have worked.
const candidateIsRoutable = async (
  targetModelId: string,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  endpointAccepts: (endpoints: ModelEndpoints) => boolean,
): Promise<boolean> => {
  if (providers.length === 0) return false;
  const interpretations = enumerateModelInterpretations(targetModelId, providers);
  const { resolutions } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);
  return resolutions.some(r => endpointAccepts(r.resolved.binding.upstreamModel.endpoints));
};

// Pre-pick the available pool ONCE. Order is preserved so
// selection=first-available picks deterministically; selection=random picks
// uniformly within whatever subset survived availability filtering.
const buildAvailablePool = async (
  record: ModelAliasRecord,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
  endpointAccepts: (endpoints: ModelEndpoints) => boolean,
): Promise<ModelAliasRecord['targets']> => {
  const availability = await Promise.all(record.targets.map(target =>
    candidateIsRoutable(target.target_model_id, providers, fetcherForUpstream, scheduler, endpointAccepts)));
  return record.targets.filter((_, index) => availability[index]);
};

export const resolveAlias = async (args: ResolveAliasArgs): Promise<AliasResolution | null> => {
  const { modelName, providers, fetcherForUpstream, scheduler, endpointAccepts, repo } = args;
  const record = await repo.getByName(modelName);
  if (!record) return null;

  const pool = await buildAvailablePool(record, providers, fetcherForUpstream, scheduler, endpointAccepts);
  if (pool.length === 0) throw new AliasNoTargetAvailableError(record.name, record.targets.length);

  const picked = record.selection === 'first-available'
    ? pool[0]
    : pool[Math.floor(Math.random() * pool.length)];

  return { targetModelId: picked.target_model_id, rules: picked.rules, aliasName: record.name };
};
