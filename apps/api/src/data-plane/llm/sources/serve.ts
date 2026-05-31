import type { Context } from 'hono';

import { createRequestContext } from './execute.ts';
import { type LlmServeFailure, LlmServeFailureError } from './failure.ts';
import { type ResponsesItemsCommit, storeResponsesOutputItems } from './responses/items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from './responses/items/request-plan.ts';
import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { ProviderModelRecord } from '../../providers/types.ts';
import { type LlmTargetApi, type RequestContext } from '../interceptors.ts';
import type { ExecuteResult } from '../shared/errors/result.ts';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { Mutable, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

type Frame<TEvent> = ProtocolFrame<TEvent>;
type Result<TEvent> = ExecuteResult<Frame<TEvent>>;

// The control flow every LLM source serve shares: look up referenced stored
// items, plan a provider order from their routing affinity, then walk that
// order resolving the model, running source interceptors, and wrapping the
// events branch so output items are persisted with the right commit timing.
// Only the protocol-shaped pieces — payload parsing, item carrier location,
// target preference, the interceptor-wrapped emit, response shaping — differ
// per API and are injected through the per-source traits.
//
// payload and request never reach this orchestrator: they live in the per-API
// closures. `setup(c)` parses the body, runs input-level pre-checks (returning
// an early `Response`), and yields a plan whose `attempt` closure captures the
// payload to clone, rewrite, and run. The orchestrator only drives the planner
// and persistence, then hands every result — success or failure — to `respond`.

export interface LlmSourcePlan<TItems, TEvent> {
  readonly request: RequestContext;
  readonly items: TItems;
  readonly responsesItemsView: ResponsesItemsView<TItems, Frame<TEvent>>;
  readonly wantsStream: boolean;
  // `store: false` requests persist null payloads; sources that have no
  // `store` concept (Messages, Gemini) pass `undefined`.
  readonly store: boolean | null | undefined;
  // The model id the planner resolves against. Most sources read it off the
  // parsed payload; Gemini carries it on the request path instead of the body.
  readonly model: string;
  readonly downstreamAbortController: AbortController | undefined;
  pickTarget(endpoints: readonly ModelEndpoint[]): LlmTargetApi | null;
  // Clones the captured payload once, rewrites that clone's items in place via
  // `rewriteItems`, builds the fully protocol-typed invocation / emit table /
  // interceptor chain, and runs. The single per-attempt clone is the sole
  // source of mutation isolation, so the rewrite runs on owned items — never on
  // the original parsed items the orchestrator still iterates read-only.
  attempt(input: {
    binding: ProviderModelRecord;
    target: LlmTargetApi;
    model: string;
    rewriteItems: (items: TItems) => Promise<Mutable<TItems>>;
  }): Promise<Result<TEvent>>;
}

export interface LlmSourceTraits<TItems, TEvent> {
  // Static — usable even before/if `setup()` runs. Maps a failure to this API's
  // error envelope and shapes the final Response from a result. `respond` only
  // reports whether the response was produced successfully; the orchestrator
  // owns what to do with that (e.g. committing stored items).
  renderFailure(failure: LlmServeFailure): Result<TEvent>;
  respond(input: {
    c: Context;
    result: Result<TEvent>;
    request: RequestContext;
    wantsStream: boolean;
    downstreamAbortController: AbortController | undefined;
  }): Promise<{ success: boolean; response: Response }>;
  setup(c: Context): Promise<LlmSourcePlan<TItems, TEvent> | Response>;
}

export const serveLlm = <TItems, TEvent>(
  traits: LlmSourceTraits<TItems, TEvent>,
) => async (c: Context): Promise<Response> => {
  // Provisional request context, built before `setup()` so a parse/setup throw
  // can still be rendered with telemetry; replaced by `plan.request` on success.
  let request = createRequestContext(c, undefined, false);
  try {
    const plan = await traits.setup(c);
    if (plan instanceof Response) return plan;
    request = plan.request;

    const prepared = await prepareStoredResponsesItemsForSource(plan.items, request.apiKeyId ?? null, plan.responsesItemsView);
    const preparedFailure = prepared.failures[0];
    if (preparedFailure) {
      const { response } = await traits.respond({
        c,
        result: traits.renderFailure(preparedFailure),
        request,
        wantsStream: plan.wantsStream,
        downstreamAbortController: plan.downstreamAbortController,
      });
      return response;
    }

    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), prepared);
    let result: Result<TEvent> | undefined;
    let commitForNonStreaming: ResponsesItemsCommit | undefined;
    let sawModel = false;
    let resolvedModelId = plan.model;
    if (providerPlan.type === 'failure') {
      result = traits.renderFailure(providerPlan.failure);
    } else for (const provider of providerPlan.providers) {
      const resolved = await resolveModelForProvider(provider, plan.model);
      if (!resolved) continue;

      sawModel = true;
      resolvedModelId = resolved.id;
      const binding = resolved.binding;
      const target = plan.pickTarget(binding.upstreamModel.upstreamEndpoints);
      if (!target) continue;

      const rawResult = await plan.attempt({
        binding,
        target,
        model: resolvedModelId,
        rewriteItems: items => rewriteStoredResponsesItemsForProvider(items, prepared, binding, plan.responsesItemsView),
      });
      if (rawResult.type === 'events') {
        const stored = storeResponsesOutputItems(rawResult.events, plan.responsesItemsView, { targetApi: target, upstream: binding.upstream, store: plan.store }, request, plan.wantsStream);
        result = { ...rawResult, events: stored.events };
        commitForNonStreaming = stored.commitForNonStreaming;
      } else {
        result = rawResult;
      }
      break;
    }

    result ??= traits.renderFailure(sawModel ? { kind: 'model-unsupported', model: resolvedModelId } : { kind: 'model-missing', model: resolvedModelId });

    // `respond` reports only whether the response was produced; the orchestrator
    // owns commit timing. `commitForNonStreaming` exists solely on a successful
    // non-streaming attempt — it flushes the buffered rows once the body is
    // known good (streaming rows were already written per frame). A failed
    // response leaves the buffer unflushed.
    const { success, response } = await traits.respond({ c, result, request, wantsStream: plan.wantsStream, downstreamAbortController: plan.downstreamAbortController });
    if (success) await commitForNonStreaming?.();
    return response;
  } catch (error) {
    const failure: LlmServeFailure = error instanceof LlmServeFailureError ? error.failure : { kind: 'internal', error };
    const { response } = await traits.respond({ c, result: traits.renderFailure(failure), request, wantsStream: false, downstreamAbortController: undefined });
    return response;
  }
};
