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
// shaping — differ per API and are injected through `SourceServeTrait`.
//
// The trait is split into an async `parse` (returns the parsed payload or an
// early Response for input-level rejections) and a `buildAttempt` factory
// invoked once the planner picks a binding. `buildAttempt` owns the fully
// protocol-typed invocation, emit table, and interceptor chain behind a single
// `run()` thunk, so the orchestrator stays agnostic of the payload type while
// still driving persistence from the returned `targetApi`/`upstream`/`store`.
export interface PreparedSourceServe<TItems, TMappedItems, TEvent> {
  // The parsed request body. The orchestrator never reads it; it is threaded
  // back to `buildAttempt` where the source casts it to its own payload shape
  // to clone and rewrite.
  readonly payload: unknown;
  readonly items: TItems;
  readonly wantsStream: boolean;
  // The model id the planner resolves against. Most sources read it off the
  // parsed payload; Gemini carries it on the request path instead of the body.
  readonly model: string;
  readonly view: ResponsesItemsView<TItems, TMappedItems, Frame<TEvent>>;
  readonly downstreamAbortController: AbortController | undefined;
}

export interface SourceServeAttempt<TEvent> {
  readonly targetApi: LlmTargetApi;
  readonly upstream: string;
  // `store: false` requests persist null payloads; sources that have no
  // `store` concept (Messages, Gemini) pass `undefined`.
  readonly store: boolean | null | undefined;
  run(): Promise<Result<TEvent>>;
}

export interface SourceServeTrait<TItems, TMappedItems, TEvent> {
  request: RequestContext;
  // Resolves the parsed payload and any input-level early Response. Runs inside
  // the orchestrator's try so parse and pre-check failures fall to the shared
  // diagnostic / source-error catch.
  parse(): Promise<PreparedSourceServe<TItems, TMappedItems, TEvent> | Response>;
  pickTarget(endpoints: readonly ModelEndpoint[]): LlmTargetApi | null;
  // `buildAttempt` clones the payload once and rewrites that clone's items in
  // place via `rewriteItems`. The single per-attempt clone is the sole source
  // of mutation isolation, so the rewrite must run on owned items — never on
  // the original parsed items the orchestrator still iterates read-only.
  buildAttempt(input: {
    binding: ProviderModelRecord;
    target: LlmTargetApi;
    model: string;
    payload: unknown;
    rewriteItems: (items: TItems) => Promise<TMappedItems>;
  }): Promise<SourceServeAttempt<TEvent>>;
  // Maps a stored-items input diagnostic to this API's error envelope; used for
  // both the prepare-time diagnostic and the thrown-diagnostic catch.
  diagnosticResponse(diagnostic: StoredResponsesItemsDiagnostic): Response;
  planErrorResult(diagnostic: StoredResponsesItemsDiagnostic): Result<TEvent>;
  missingModelResult(model: string): Result<TEvent>;
  unsupportedModelResult(model: string): Result<TEvent>;
  sourceErrorResult(error: unknown): Result<TEvent>;
  respond(input: { result: Result<TEvent>; wantsStream: boolean; commit?: ResponsesItemsCommit; downstreamAbortController: AbortController | undefined }): Promise<Response>;
}

export const serveStoredResponsesItems = async <TItems, TMappedItems, TEvent>(trait: SourceServeTrait<TItems, TMappedItems, TEvent>): Promise<Response> => {
  let downstreamAbortController: AbortController | undefined;
  try {
    const prepared = await trait.parse();
    if (prepared instanceof Response) return prepared;
    downstreamAbortController = prepared.downstreamAbortController;
    const { payload, items, wantsStream, model, view } = prepared;
    const { request } = trait;

    const preparedStoredItems = await prepareStoredResponsesItemsForSource(items, request.apiKeyId ?? null, view);
    const preparedDiagnostic = preparedStoredItems.diagnostics[0];
    if (preparedDiagnostic) return trait.diagnosticResponse(preparedDiagnostic);

    let result: Result<TEvent> | undefined;
    let commit: ResponsesItemsCommit | undefined;
    const providerPlan = planResponsesItemProviders(await listModelProviders(request.apiKeyUpstreamIds), preparedStoredItems);
    let resolvedModelId = model;
    let sawModel = false;
    if (providerPlan.type === 'error') {
      result = trait.planErrorResult(providerPlan.diagnostic);
    } else for (const provider of providerPlan.providers) {
      const resolved = await resolveModelForProvider(provider, model);
      if (!resolved) continue;

      sawModel = true;
      resolvedModelId = resolved.id;
      const binding = resolved.binding;
      const target = trait.pickTarget(binding.upstreamModel.upstreamEndpoints);
      if (!target) continue;

      const rewriteItems = (clonedItems: TItems): Promise<TMappedItems> =>
        rewriteStoredResponsesItemsForProvider(clonedItems, preparedStoredItems, binding, view);
      const attempt = await trait.buildAttempt({ binding, target, model: resolvedModelId, payload, rewriteItems });

      const rawResult = await attempt.run();
      if (rawResult.type === 'events') {
        const stored = storeResponsesOutputItems(rawResult.events, view, { targetApi: attempt.targetApi, upstream: attempt.upstream, store: attempt.store }, request, wantsStream);
        result = { ...rawResult, events: stored.events };
        commit = stored.commit;
      } else {
        result = rawResult;
      }
      break;
    }

    result ??= sawModel ? trait.unsupportedModelResult(resolvedModelId) : trait.missingModelResult(resolvedModelId);

    return await trait.respond({ result, wantsStream, commit, downstreamAbortController });
  } catch (error) {
    if (error instanceof StoredResponsesItemsDiagnosticError) {
      return trait.diagnosticResponse(error.diagnostic);
    }
    return await trait.respond({ result: trait.sourceErrorResult(error), wantsStream: false, downstreamAbortController });
  }
};
