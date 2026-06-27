import { type ChatServeFailure, aliasFailureFromError } from './errors.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { ALIAS_RESPONSE_HEADER } from '../../model-aliases/header.ts';
import { AliasNoTargetAvailableError, type AliasResolution } from '../../model-aliases/resolve.ts';
import { resolveModelCandidates } from '../../providers/registry.ts';
import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

// Shared serve-side prelude every chat protocol runs before routing: resolve
// candidates against the live registry, redirect through the alias resolver
// when the inbound model id is an alias, stage the response header, and
// hand the protocol's own callback the resolution so it can overlay rules
// and (where the protocol mutates it) rewrite `payload.model`. The
// `AliasNoTargetAvailableError` 404 is converted to whatever rendered
// failure the protocol returns from its serve seam, so callers stay free
// of the alias machinery.
export interface ResolveCandidatesArgs<F> {
  readonly ctx: GatewayCtx;
  readonly modelName: string;
  readonly pickTarget: (endpoints: ModelEndpoints) => ChatTargetApi | null;
  // Invoked exactly when an alias matched; the callback overlays rules
  // and (for protocols that mutate it) updates the inbound payload's
  // model field. The response header is staged by this helper.
  readonly applyAlias: (resolution: AliasResolution) => void;
  // Renders this protocol's failure envelope from a ChatServeFailure.
  // Used only on the alias-no-target path — every other failure mode
  // is handled by the caller after this helper returns ok.
  readonly renderAliasFailure: (failure: Extract<ChatServeFailure, { kind: 'alias-no-target-available' }>) => F;
}

export type ResolveCandidatesOk = {
  readonly kind: 'ok';
  readonly candidates: readonly ProviderCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
  readonly aliasResolution: AliasResolution | null;
};

export type ResolveCandidatesOutcome<F> =
  | ResolveCandidatesOk
  | { readonly kind: 'failure'; readonly result: F };

export const resolveCandidatesAndApplyAlias = async <F>(args: ResolveCandidatesArgs<F>): Promise<ResolveCandidatesOutcome<F>> => {
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
      return { kind: 'failure', result: renderAliasFailure(aliasFailureFromError(error)) };
    }
    throw error;
  }
  const { candidates, sawModel, failedUpstreams, aliasResolution } = enumerated;
  if (aliasResolution !== null) {
    applyAlias(aliasResolution);
    ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, aliasResolution.aliasName);
  }
  return { kind: 'ok', candidates, sawModel, failedUpstreams, aliasResolution };
};
