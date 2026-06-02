import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { RequestContext } from '../interceptors.ts';
import { responsesItemId } from './responses/items/format.ts';
import { type ResponsesItemsCommit, storeResponsesOutputItems } from './responses/items/output.ts';
import {
  planResponsesItemProviders,
  type PreparedStoredResponsesItems,
  prepareStoredResponsesItemsForSource,
  rewriteStoredResponsesItemsForProvider,
  type StoredResponsesProviderPlan,
} from './responses/items/request-plan.ts';
import type { LlmEndpointPlan, LlmServeFailure, Result } from './traits.ts';

export interface LlmSourceExecution<TEvent> {
  result: Result<TEvent>;
  commitForNonStreaming?: ResponsesItemsCommit;
}

export type RenderLlmFailure<TEvent> = (failure: LlmServeFailure) => Result<TEvent>;

export const executeLlmSourcePlan = async <TItems, TEvent>(
  plan: LlmEndpointPlan<TItems, TEvent>,
  renderFailure: RenderLlmFailure<TEvent>,
): Promise<LlmSourceExecution<TEvent>> => {
  const prepared = await prepareStoredResponsesItemsForSource(plan.items, plan.request.apiKeyId ?? null, plan.responsesItemsView);
  if (prepared.failures[0]) return { result: renderFailure(prepared.failures[0]) };

  const providerPlan = planResponsesItemProviders(await listModelProviders(plan.request.apiKeyUpstreamIds), prepared);
  return await attemptProviders(providerPlan, plan, prepared, renderFailure);
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
  renderFailure: RenderLlmFailure<TEvent>,
): Promise<LlmSourceExecution<TEvent>> => {
  if (providerPlan.type === 'failure') return { result: renderFailure(providerPlan.failure) };

  let sawModel = false;
  for (const provider of providerPlan.providers) {
    const resolved = await resolveModelForProvider(provider, plan.model);
    if (!resolved) continue;
    sawModel = true;

    const { binding } = resolved;
    const target = plan.pickTarget(binding.upstreamModel.endpoints);
    if (!target) continue;

    resetAttemptStatefulResponsesContext(plan.request, prepared);

    const rawResult = await plan.attempt({
      binding,
      target,
      model: resolved.id,
      rewriteItems: items => rewriteStoredResponsesItemsForProvider(items, prepared, binding, plan.responsesItemsView),
    });
    if (rawResult.type !== 'events') return { result: rawResult };

    const stored = storeResponsesOutputItems(rawResult.events, plan.responsesItemsView, { targetApi: target, upstream: binding.upstream, store: plan.store }, plan.request, plan.wantsStream);
    return { result: { ...rawResult, events: stored.events }, commitForNonStreaming: stored.commitForNonStreaming };
  }

  // The diagnostic names the model the client requested, not whichever upstream
  // id a provider resolved it to.
  return { result: renderFailure(sawModel ? { kind: 'model-unsupported', model: plan.model } : { kind: 'model-missing', model: plan.model }) };
};

const resetAttemptStatefulResponsesContext = (request: RequestContext, prepared: PreparedStoredResponsesItems): void => {
  // Fresh stateful bag per attempt so a failed earlier attempt's shim writes do
  // not leak into the next provider attempt.
  request.statefulResponsesContext = {
    privatePayload: new Map(prepared.references.flatMap(ref => {
      const wireId = ref.row?.payload && responsesItemId(ref.row.payload.item as { id?: unknown });
      return wireId && ref.row?.payload?.private !== undefined ? [[wireId, ref.row.payload.private] as const] : [];
    })),
    newSyntheticIds: new Set(),
  };
};
