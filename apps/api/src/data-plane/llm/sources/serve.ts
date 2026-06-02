import type { Context } from 'hono';

import { createRequestContext } from './request-context.ts';
import type { RequestContext } from '../interceptors.ts';
import { responsesItemId } from './responses/items/format.ts';
import { type ResponsesItemsCommit, storeResponsesOutputItems } from './responses/items/output.ts';
import { planResponsesItemProviders, type PreparedStoredResponsesItems, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider, type StoredResponsesProviderPlan } from './responses/items/request-plan.ts';
import { type LlmEndpointName, type LlmEndpointPlan, type LlmServeFailure, LlmServeFailureError, type LlmSourceTraits, type Result } from './traits.ts';
import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';

// The control flow every LLM source endpoint shares: look up referenced stored
// items, plan a provider order from their routing affinity, then walk that
// order resolving the model, running source interceptors, and wrapping the
// events branch so output items are persisted with the right commit timing.
// Only the protocol-shaped pieces — payload parsing, item carrier location,
// target preference, the interceptor-wrapped emit, response shaping — differ
// per API/endpoint and are injected through the per-source traits.
//
// A source declares one or more endpoints (generate, count_tokens);
// `serveLlm(traits, endpointName)` binds one of them to a route. payload and
// request never reach this orchestrator: they live in the per-endpoint
// closures. `setup(c)` parses the body, runs input-level pre-checks (returning
// an early `Response`), and yields a plan whose `attempt` closure captures the
// payload to clone, rewrite, and run. The orchestrator only drives the planner
// and persistence, then hands every result — success or failure — to `respond`.

export const serveLlm = <TItems, TEvent>(
  traits: LlmSourceTraits<TItems, TEvent>,
  endpointName: LlmEndpointName,
) => {
  const endpoint = traits.endpoints[endpointName];
  if (!endpoint) throw new Error(`LLM source does not define the '${endpointName}' endpoint.`);

  return async (c: Context): Promise<Response> => {
    // `request`/`wantsStream`/abort start provisional so a parse or setup throw
    // can still be rendered with telemetry; `setup` replaces them on success.
    // `respond` closes over them so every call site — early diagnostic, main
    // path, and catch — renders identically.
    let request = createRequestContext(c, undefined, false);
    let wantsStream = false;
    let downstreamAbortController: AbortController | undefined;
    const respond = (result: Result<TEvent>): Promise<{ success: boolean; response: Response }> =>
      endpoint.respond({ c, result, request, wantsStream, downstreamAbortController });
    const renderFailure = (failure: LlmServeFailure): Result<TEvent> => traits.renderFailure(failure, endpointName);

    try {
      const plan = await endpoint.setup(c);
      if (plan instanceof Response) return plan;
      ({ request, wantsStream, downstreamAbortController } = plan);

      const prepared = await prepareStoredResponsesItemsForSource(plan.items, request.apiKeyId ?? null, plan.responsesItemsView);
      if (prepared.failures[0]) return (await respond(renderFailure(prepared.failures[0]))).response;

      const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), prepared);
      const { result, commitForNonStreaming } = await attemptProviders(providerPlan, plan, prepared, request, renderFailure);

      // `respond` reports only whether the response was produced; the orchestrator
      // owns commit timing. `commitForNonStreaming` exists solely on a successful
      // non-streaming attempt — it flushes the buffered rows once the body is
      // known good (streaming rows were already written per frame). A failed
      // response leaves the buffer unflushed.
      const { success, response } = await respond(result);
      if (success) await commitForNonStreaming?.();
      return response;
    } catch (error) {
      const failure: LlmServeFailure = error instanceof LlmServeFailureError ? error.failure : { kind: 'internal', error };
      return (await respond(renderFailure(failure))).response;
    }
  };
};

// Walk the planned providers in order: resolve the model, pick a target, run
// the attempt; the first provider yielding an upstream result wins, with its
// output items wrapped for persistence. A provider whose model or target does
// not resolve is skipped. An exhausted walk renders the model diagnostic —
// missing when no provider had the model, unsupported when one did but offered
// no usable target.
const attemptProviders = async <TItems, TEvent>(
  providerPlan: StoredResponsesProviderPlan,
  plan: LlmEndpointPlan<TItems, TEvent>,
  prepared: PreparedStoredResponsesItems,
  request: RequestContext,
  renderFailure: (failure: LlmServeFailure) => Result<TEvent>,
): Promise<{ result: Result<TEvent>; commitForNonStreaming?: ResponsesItemsCommit }> => {
  if (providerPlan.type === 'failure') return { result: renderFailure(providerPlan.failure) };

  let sawModel = false;
  for (const provider of providerPlan.providers) {
    const resolved = await resolveModelForProvider(provider, plan.model);
    if (!resolved) continue;
    sawModel = true;

    const { binding } = resolved;
    const target = plan.pickTarget(binding.upstreamModel.endpoints);
    if (!target) continue;

    // Fresh stateful bag per attempt so a failed earlier attempt's shim
    // writes — private payloads stashed under tmp ids that won't be minted
    // again, new synthetic ids that no output stream will reference — don't
    // leak into the next attempt. Seed key is the wire id the rewriter will
    // produce: only synthetic rows carry `payload.private`, and the rewriter
    // preserves their `payload.item.id` verbatim, so the lookup reads that
    // id directly.
    request.statefulResponsesContext = {
      privatePayload: new Map(prepared.references.flatMap(ref => {
        const wireId = ref.row?.payload && responsesItemId(ref.row.payload.item as { id?: unknown });
        return wireId && ref.row?.payload?.private !== undefined ? [[wireId, ref.row.payload.private] as const] : [];
      })),
      newSyntheticIds: new Set(),
    };

    const rawResult = await plan.attempt({
      binding,
      target,
      model: resolved.id,
      rewriteItems: items => rewriteStoredResponsesItemsForProvider(items, prepared, binding, plan.responsesItemsView),
    });
    if (rawResult.type !== 'events') return { result: rawResult };

    const stored = storeResponsesOutputItems(rawResult.events, plan.responsesItemsView, { targetApi: target, upstream: binding.upstream, store: plan.store }, request, plan.wantsStream);
    return { result: { ...rawResult, events: stored.events }, commitForNonStreaming: stored.commitForNonStreaming };
  }

  // The diagnostic names the model the client requested, not whichever upstream
  // id a provider resolved it to.
  return { result: renderFailure(sawModel ? { kind: 'model-unsupported', model: plan.model } : { kind: 'model-missing', model: plan.model }) };
};
