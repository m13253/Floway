import { ALIAS_RESPONSE_HEADER } from './header.ts';
import { AliasNoTargetAvailableError, type AliasResolution, resolveAlias } from './resolve.ts';
import { createPerRequestFetcher } from '../../dial/per-request.ts';
import { getRepo } from '../../repo/index.ts';
import type { GatewayCtx } from '../chat/shared/gateway-ctx.ts';
import { enumerateRealModelCandidatesWithDatedRetry, listModelProviders } from '../providers/registry.ts';
import type { ModelEndpoints, ModelKind } from '@floway-dev/protocols/common';
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
// per-call `candidate.model.id` rewrite happens at the provider boundary,
// not on the inbound body.
export interface ResolveCandidatesArgs<F> {
  readonly ctx: GatewayCtx;
  readonly modelName: string;
  // Inbound endpoint family. Threaded into both the per-target candidate
  // walk inside the alias resolver and the per-request real-model walk so
  // wrong-kind catalog entries never enter the candidate list.
  readonly kind: ModelKind;
  // Endpoint-accepting predicate the alias resolver uses to narrow the
  // target pool to bindings whose wire actually serves the inbound
  // operation. Chat protocols pass the matching `chatTargetPicker.canServe`;
  // passthrough seams check the specific endpoint key. The same predicate
  // never re-narrows the per-request `candidates` array — protocol serve
  // code filters that itself with the matching picker, so the prelude
  // stays uniform across chat/passthrough.
  readonly endpointAccepts: (endpoints: ModelEndpoints) => boolean;
  readonly applyAlias?: (resolution: AliasResolution) => void;
  readonly renderAliasFailure: (failure: AliasNoTargetFailure) => F;
}

export type ResolveCandidatesOk = {
  readonly kind: 'ok';
  readonly candidates: readonly ProviderCandidate[];
  readonly sawModel: boolean;
  readonly failedUpstreams: readonly string[];
  readonly aliasResolution: AliasResolution | null;
  // The model id every downstream surface should use: the alias's
  // `target_model_id` when an alias matched, the original inbound id
  // otherwise. Body-based protocols (chat-completions/messages/responses)
  // already mutate `payload.model` in their `applyAlias` callback and read
  // that; path-based protocols (Gemini routes the id in the URL) have
  // nowhere to mutate and read this field instead.
  readonly effectiveModelId: string;
};

export type ResolveCandidatesOutcome<F> =
  | ResolveCandidatesOk
  | { readonly kind: 'failure'; readonly result: F };

export const resolveCandidatesAndApplyAlias = async <F>(args: ResolveCandidatesArgs<F>): Promise<ResolveCandidatesOutcome<F>> => {
  const { ctx, modelName, kind, endpointAccepts, applyAlias, renderAliasFailure } = args;

  // Share the provider list and per-request fetcher across the alias
  // resolver and the per-target candidate walk so the upstream-list +
  // proxy-factory round-trip is paid once per request rather than twice.
  const fetcherForUpstream = await createPerRequestFetcher(ctx.currentColo);
  const providers = await listModelProviders(ctx.upstreamIds);

  let aliasResolution: AliasResolution | null;
  try {
    aliasResolution = await resolveAlias({
      modelName,
      providers,
      fetcherForUpstream,
      scheduler: ctx.backgroundScheduler,
      kind,
      endpointAccepts,
      repo: getRepo().modelAliases,
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

  const effectiveModelId = aliasResolution?.targetModelId ?? modelName;
  const { candidates, sawModel, failedUpstreams } = await enumerateRealModelCandidatesWithDatedRetry(
    effectiveModelId,
    kind,
    providers,
    fetcherForUpstream,
    ctx.backgroundScheduler,
  );

  if (aliasResolution !== null) {
    applyAlias?.(aliasResolution);
    ctx.responseHeaders.set(ALIAS_RESPONSE_HEADER, aliasResolution.aliasName);
  }
  return {
    kind: 'ok',
    candidates,
    sawModel,
    failedUpstreams,
    aliasResolution,
    effectiveModelId,
  };
};
