import { listModelProviders, resolveModelForProvider } from '../../providers/registry.ts';
import type { ProviderModelRecord } from '../../providers/types.ts';
import { type LlmTargetApi, type RequestContext } from '../interceptors.ts';
import type { ExecuteResult } from '../shared/errors/result.ts';
import { type StoredResponsesItemsDiagnostic, StoredResponsesItemsDiagnosticError } from './responses/items/errors.ts';
import { type ResponsesItemsCommit, storeResponsesOutputItems } from './responses/items/output.ts';
import { planResponsesItemProviders, prepareStoredResponsesItemsForSource, rewriteStoredResponsesItemsForProvider } from './responses/items/request-plan.ts';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

type Frame<TEvent> = ProtocolFrame<TEvent>;
type Result<TEvent> = ExecuteResult<Frame<TEvent>>;

// The control flow every stored-Responses-items source serve shares: look up
// referenced stored items, plan a provider order from their routing affinity,
// then walk that order resolving the model, running source interceptors, and
// wrapping the events branch so output items are persisted with the right
// commit timing. Only the protocol-shaped pieces — payload parsing, item
// carrier location, target preference, the interceptor-wrapped emit, response
// shaping — differ per API and are injected through the descriptor.
//
// payload and request never reach this orchestrator: they live in the per-API
// closures. `setup()` parses the body, runs input-level pre-checks (returning
// an early `Response`), and yields a plan whose `attempt` closure captures the
// payload to clone, rewrite, and run. The orchestrator only drives the planner
// and persistence, then hands every result — success or failure — to `respond`.

// The four ways stored-items serving can fail before a usable upstream result.
// `diagnostic` covers both prepare-time input diagnostics and the planner's
// routing diagnostic; `model-missing`/`model-unsupported` describe the planner
// walk finding no usable binding; `source-error` is the top-level catch.
export type StoredItemsFailure =
  | { kind: 'diagnostic'; diagnostic: StoredResponsesItemsDiagnostic }
  | { kind: 'model-missing'; model: string }
  | { kind: 'model-unsupported'; model: string }
  | { kind: 'source-error'; error: unknown };

export interface StoredItemsServePlan<TItems, TMappedItems, TEvent> {
  readonly request: RequestContext;
  readonly items: TItems;
  readonly view: ResponsesItemsView<TItems, TMappedItems, Frame<TEvent>>;
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
    rewriteItems: (items: TItems) => Promise<TMappedItems>;
  }): Promise<Result<TEvent>>;
}

export interface StoredItemsServeDescriptor<TItems, TMappedItems, TEvent> {
  // The provisional request context, built before `setup()` so a parse/setup
  // throw can still be rendered with telemetry; replaced by `plan.request` on
  // success.
  readonly request: RequestContext;
  // Static — usable even before/if `setup()` runs. Maps a failure to this API's
  // error envelope and shapes the final Response from a result.
  renderFailure(failure: StoredItemsFailure): Result<TEvent>;
  respond(input: {
    result: Result<TEvent>;
    request: RequestContext;
    wantsStream: boolean;
    commit?: ResponsesItemsCommit;
    downstreamAbortController: AbortController | undefined;
  }): Promise<Response>;
  setup(): Promise<StoredItemsServePlan<TItems, TMappedItems, TEvent> | Response>;
}

export const serveStoredResponsesItems = async <TItems, TMappedItems, TEvent>(
  d: StoredItemsServeDescriptor<TItems, TMappedItems, TEvent>,
): Promise<Response> => {
  let request = d.request;
  try {
    const plan = await d.setup();
    if (plan instanceof Response) return plan;
    request = plan.request;

    const prepared = await prepareStoredResponsesItemsForSource(plan.items, request.apiKeyId ?? null, plan.view);
    const preparedDiagnostic = prepared.diagnostics[0];
    if (preparedDiagnostic) {
      return await d.respond({
        result: d.renderFailure({ kind: 'diagnostic', diagnostic: preparedDiagnostic }),
        request,
        wantsStream: plan.wantsStream,
        downstreamAbortController: plan.downstreamAbortController,
      });
    }

    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), prepared);
    let result: Result<TEvent> | undefined;
    let commit: ResponsesItemsCommit | undefined;
    let sawModel = false;
    let resolvedModelId = plan.model;
    if (providerPlan.type === 'error') {
      result = d.renderFailure({ kind: 'diagnostic', diagnostic: providerPlan.diagnostic });
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
        rewriteItems: items => rewriteStoredResponsesItemsForProvider(items, prepared, binding, plan.view),
      });
      if (rawResult.type === 'events') {
        const stored = storeResponsesOutputItems(rawResult.events, plan.view, { targetApi: target, upstream: binding.upstream, store: plan.store }, request, plan.wantsStream);
        result = { ...rawResult, events: stored.events };
        commit = stored.commit;
      } else {
        result = rawResult;
      }
      break;
    }

    result ??= d.renderFailure(sawModel ? { kind: 'model-unsupported', model: resolvedModelId } : { kind: 'model-missing', model: resolvedModelId });

    return await d.respond({ result, request, wantsStream: plan.wantsStream, commit, downstreamAbortController: plan.downstreamAbortController });
  } catch (error) {
    const failure: StoredItemsFailure = error instanceof StoredResponsesItemsDiagnosticError
      ? { kind: 'diagnostic', diagnostic: error.diagnostic }
      : { kind: 'source-error', error };
    return await d.respond({ result: d.renderFailure(failure), request, wantsStream: false, downstreamAbortController: undefined });
  }
};
