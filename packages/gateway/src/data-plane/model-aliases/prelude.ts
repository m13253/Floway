import { ALIAS_RESPONSE_HEADER } from './header.ts';
import { AliasNoTargetAvailableError, type AliasResolution } from './resolve.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { resolveModelCandidates } from '../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ProviderCandidate } from '@floway-dev/provider';

// Structural shape every protocol's no-target-available renderer accepts.
// Mirrors `Extract<ChatServeFailure, { kind: 'alias-no-target-available' }>`
// without binding the alias plumbing to the chat-specific failure union.
export interface AliasNoTargetFailure {
  readonly kind: 'alias-no-target-available';
  readonly message: string;
}

// Shared serve-side prelude every chat protocol — and the passthrough seam —
// runs before routing. Resolves candidates against the live registry, runs
// the alias resolver when the inbound id is an alias, stages the
// `x-floway-alias` response header on every alias-touched code path
// (including the no-target 404), and converts
// `AliasNoTargetAvailableError` to whatever rendered failure the caller's
// `renderAliasFailure` produces. Chat protocols also overlay rules onto the
// payload via `applyAlias`; passthrough leaves it undefined because the
// per-call `binding.upstreamModel.id` rewrite happens at the provider
// boundary, not on the inbound body.
//
// Generic over the resolver's per-protocol target descriptor (chat returns
// `ChatTargetApi`, passthrough returns `ModelEndpointKey`).
export interface ResolveCandidatesArgs<TTarget, F> {
  readonly ctx: GatewayCtx;
  readonly modelName: string;
  readonly pickTarget: (endpoints: ModelEndpoints) => TTarget | null;
  readonly applyAlias?: (resolution: AliasResolution) => void;
  readonly renderAliasFailure: (failure: AliasNoTargetFailure) => F;
}

export type ResolveCandidatesOk<TTarget> = {
  readonly kind: 'ok';
  readonly candidates: ReadonlyArray<ProviderCandidate & { readonly targetApi: TTarget }>;
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
  readonly aliasResolution: AliasResolution | null;
};

export type ResolveCandidatesOutcome<TTarget, F> =
  | ResolveCandidatesOk<TTarget>
  | { readonly kind: 'failure'; readonly result: F };

export const resolveCandidatesAndApplyAlias = async <TTarget, F>(args: ResolveCandidatesArgs<TTarget, F>): Promise<ResolveCandidatesOutcome<TTarget, F>> => {
  const { ctx, modelName, pickTarget, applyAlias, renderAliasFailure } = args;
  let enumerated;
  try {
    enumerated = await resolveModelCandidates({
      upstreamIds: ctx.upstreamIds,
      modelName,
      pickTarget,
      scheduler: ctx.backgroundScheduler,
      currentColo: ctx.currentColo,
    });
  } catch (error) {
    if (error instanceof AliasNoTargetAvailableError) {
      // Header staged on the 404 too — observability ties together "client
      // asked for X" / "alias X had no routable target" without parsing
      // the body. finalizeGatewayResponse copies ctx.responseHeaders onto
      // every outbound response, including rendered failures.
      ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, error.aliasName);
      return { kind: 'failure', result: renderAliasFailure({ kind: 'alias-no-target-available', message: error.message }) };
    }
    throw error;
  }
  const { candidates, sawModel, failedUpstreams, aliasResolution } = enumerated;
  if (aliasResolution !== null) {
    applyAlias?.(aliasResolution);
    ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, aliasResolution.aliasName);
  }
  return { kind: 'ok', candidates: candidates as ResolveCandidatesOk<TTarget>['candidates'], sawModel, failedUpstreams, aliasResolution };
};
