// Alias resolver. Runs once per request, above prefix routing. The target
// string it returns is fed verbatim back into the existing prefix-router
// (enumerateModelInterpretations → resolveModelForProvider); alias names
// never re-enter the alias layer, so recursion is impossible by
// construction and the shadow-the-real-model pattern (an alias whose first
// target is its own name) Just Works.
//
// The resolver is endpoint-blind: alias names are opaque global mappings
// and the routability filter only checks whether a target id resolves to
// any enabled upstream binding. A kind-mismatched call (e.g. a chat alias
// hit from /embeddings) gets the resolved target id back; if that target
// does not expose the inbound endpoint, prefix routing surfaces the natural
// "endpoint not supported" 404. The `AliasKind` on the row only governs UI
// rule forms and the `/v1/models` listing block.

import type { ModelAliasesRepo, ModelAliasRecord } from '../../repo/types.ts';
import { collectInterpretationOutcomes, enumerateModelInterpretations } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { AliasRules } from '@floway-dev/protocols/common';
import type { Fetcher, ModelProviderInstance } from '@floway-dev/provider';

export interface AliasResolution {
  readonly targetModelId: string;
  readonly rules: AliasRules;
  // Original alias name, for the `x-floway-alias` response header and dump
  // attribution.
  readonly aliasName: string;
}

// Canonical wording for the alias-no-target-available 404. The Error class
// and every protocol-shaped renderer (chat/{*}/errors.ts, passthroughServe)
// read the same string from here so wording changes land in one place.
export const aliasNoTargetMessage = (params: { aliasName: string; targetCount: number }): string =>
  `alias '${params.aliasName}' has ${params.targetCount} target(s); none currently map to an enabled upstream binding`;

// Thrown when the alias name was found but no target currently resolves to
// an enabled upstream binding. Caught at each protocol's serve seam and
// surfaced as a 404 in the protocol-specific error envelope.
export class AliasNoTargetAvailableError extends Error {
  readonly aliasName: string;
  readonly targetCount: number;

  constructor(aliasName: string, targetCount: number) {
    super(aliasNoTargetMessage({ aliasName, targetCount }));
    this.name = 'AliasNoTargetAvailableError';
    this.aliasName = aliasName;
    this.targetCount = targetCount;
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
  // Injected so tests can hand in a stub; the per-request ctx already owns
  // a concrete one via `getRepo().modelAliases`.
  readonly repo: ModelAliasesRepo;
}

// Reports true when the target id resolves to at least one enabled upstream
// binding, irrespective of which endpoint that binding exposes. Endpoint
// suitability is the prefix-routing layer's job; the resolver only proves
// the target is reachable somewhere in the catalog.
const candidateIsRoutable = async (
  targetModelId: string,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<boolean> => {
  if (providers.length === 0) return false;
  const interpretations = enumerateModelInterpretations(targetModelId, providers);
  const { resolutions } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);
  return resolutions.length > 0;
};

// Pre-pick the available pool ONCE. Order is preserved so
// selection=first-available picks deterministically; selection=random picks
// uniformly within whatever subset survived availability filtering.
const buildAvailablePool = async (
  record: ModelAliasRecord,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<ModelAliasRecord['targets']> => {
  const availability = await Promise.all(record.targets.map(target =>
    candidateIsRoutable(target.target_model_id, providers, fetcherForUpstream, scheduler)));
  return record.targets.filter((_, index) => availability[index]);
};

export const resolveAlias = async (args: ResolveAliasArgs): Promise<AliasResolution | null> => {
  const { modelName, providers, fetcherForUpstream, scheduler, repo } = args;
  const record = await repo.getByName(modelName);
  if (!record) return null;

  const pool = await buildAvailablePool(record, providers, fetcherForUpstream, scheduler);
  if (pool.length === 0) throw new AliasNoTargetAvailableError(record.name, record.targets.length);

  const picked = record.selection === 'first-available'
    ? pool[0]
    : pool[Math.floor(Math.random() * pool.length)];

  return { targetModelId: picked.target_model_id, rules: picked.rules, aliasName: record.name };
};
