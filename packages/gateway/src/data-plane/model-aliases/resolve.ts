// Alias resolver. Runs once per request, above prefix routing. The target
// string it returns is fed verbatim back into the existing prefix-router
// (enumerateModelInterpretations → resolveModelForProvider); alias names
// never re-enter the alias layer, so recursion is impossible by
// construction and the shadow-the-real-model pattern (an alias whose first
// target is its own name) Just Works.

import { createPerRequestFetcher } from '../../dial/per-request.ts';
import type { ModelAliasesRepo, ModelAliasRecord } from '../../repo/types.ts';
import { collectInterpretationOutcomes, enumerateModelInterpretations, listModelProviders } from '../providers/registry.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { AliasKind, AliasRules, ModelEndpointKey } from '@floway-dev/protocols/common';
import type { Fetcher, ModelProviderInstance } from '@floway-dev/provider';

// Endpoint family the inbound request belongs to. Mirrors `AliasKind` but
// named in the data-plane vocabulary so the resolver argument site reads as
// "this is the request's endpoint group", not "this is some alias".
export type AliasEndpointKind = AliasKind;

// The endpoints (`ModelEndpoints` keys) an inbound `AliasEndpointKind` will
// accept. A target row is considered routable when it resolves to a binding
// whose `endpoints` map contains any one of these keys. Chat aliases accept
// any chat surface — the source serve will pick the actual upstream target
// API when it runs.
const ENDPOINTS_FOR_KIND: Record<AliasEndpointKind, readonly ModelEndpointKey[]> = {
  chat: ['chatCompletions', 'responses', 'messages'],
  embedding: ['embeddings'],
  image: ['imagesGenerations', 'imagesEdits'],
};

export interface AliasResolution {
  readonly targetModelId: string;
  readonly rules: AliasRules;
  // Original alias name, for the `x-floway-alias` response header and dump
  // attribution.
  readonly aliasName: string;
}

// Thrown when the alias name was found but no target currently resolves to
// an enabled upstream binding that exposes the inbound endpoint. Caught at
// each protocol's serve seam and surfaced as a 404 in the protocol-specific
// error envelope.
export class AliasNoTargetAvailableError extends Error {
  readonly aliasName: string;
  readonly targetCount: number;

  constructor(aliasName: string, targetCount: number) {
    super(`alias '${aliasName}' has ${targetCount} target(s); none currently map to an enabled upstream binding`);
    this.name = 'AliasNoTargetAvailableError';
    this.aliasName = aliasName;
    this.targetCount = targetCount;
  }
}

// Lift `AliasNoTargetAvailableError` into a `ChatServeFailure` so the
// existing failure renderer can surface it without special-casing.
export const aliasFailureFromError = (error: AliasNoTargetAvailableError): { kind: 'alias-no-target-available'; aliasName: string; targetCount: number } => ({
  kind: 'alias-no-target-available',
  aliasName: error.aliasName,
  targetCount: error.targetCount,
});

interface ResolveAliasArgs {
  readonly modelName: string;
  readonly endpointKind: AliasEndpointKind;
  // Upstream cap intersected from the per-user + per-api-key whitelists.
  // null means unrestricted; matches the same parameter on
  // `enumerateProviderCandidates` / `listModelProviders`.
  readonly upstreamIds: readonly string[] | null;
  readonly scheduler: BackgroundScheduler;
  readonly currentColo: string;
  // Injected so tests can hand in a stub; the per-request ctx already owns
  // a concrete one via `getRepo().modelAliases`.
  readonly repo: ModelAliasesRepo;
}

// Reports true when the target id resolves to at least one enabled upstream
// binding exposing an endpoint the inbound `endpointKind` cares about.
// `fetcherForUpstream` and `providers` are passed in (not derived here) so a
// caller filtering N targets hits the underlying repo / dial factories once,
// not N times.
const candidateIsRoutable = async (
  targetModelId: string,
  endpointKind: AliasEndpointKind,
  providers: readonly ModelProviderInstance[],
  fetcherForUpstream: (upstreamId: string) => Fetcher,
  scheduler: BackgroundScheduler,
): Promise<boolean> => {
  if (providers.length === 0) return false;
  const interpretations = enumerateModelInterpretations(targetModelId, providers);
  const { resolutions } = await collectInterpretationOutcomes(interpretations, fetcherForUpstream, scheduler);
  const accepted = ENDPOINTS_FOR_KIND[endpointKind];
  return resolutions.some(({ resolved }) =>
    accepted.some(key => resolved.binding.upstreamModel.endpoints[key] !== undefined));
};

// Pre-pick the available pool ONCE. Order is preserved so
// selection=first-available picks deterministically; selection=random picks
// uniformly within whatever subset survived availability filtering.
const buildAvailablePool = async (
  record: ModelAliasRecord,
  endpointKind: AliasEndpointKind,
  upstreamIds: readonly string[] | null,
  scheduler: BackgroundScheduler,
  currentColo: string,
): Promise<ModelAliasRecord['targets']> => {
  // Hoist both registry calls out of the per-target loop: their results
  // depend only on (upstreamIds, currentColo), not on the target id, so the
  // upstreams-list + proxy-factory cost is paid once per alias instead of
  // once per target row.
  const fetcherForUpstream = await createPerRequestFetcher(currentColo);
  const providers = await listModelProviders(upstreamIds);
  const availability = await Promise.all(record.targets.map(target =>
    candidateIsRoutable(target.target_model_id, endpointKind, providers, fetcherForUpstream, scheduler)));
  return record.targets.filter((_, index) => availability[index]);
};

export const resolveAlias = async (args: ResolveAliasArgs): Promise<AliasResolution | null> => {
  const { modelName, endpointKind, upstreamIds, scheduler, currentColo, repo } = args;
  const record = await repo.getByName(modelName);
  if (!record) return null;

  // Kind-mismatch is silent: the literal string falls through to prefix
  // routing, which will 404 on its own if nothing in the catalog matches.
  // Mirrors the "unknown model" surface a plain id would produce.
  if (record.kind !== endpointKind) return null;

  const pool = await buildAvailablePool(record, endpointKind, upstreamIds, scheduler, currentColo);
  if (pool.length === 0) throw new AliasNoTargetAvailableError(record.name, record.targets.length);

  const picked = record.selection === 'first-available'
    ? pool[0]
    : pool[Math.floor(Math.random() * pool.length)];

  return { targetModelId: picked.target_model_id, rules: picked.rules, aliasName: record.name };
};
