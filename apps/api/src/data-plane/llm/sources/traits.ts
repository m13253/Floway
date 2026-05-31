import type { Context } from 'hono';

import type { PerformanceApiName } from '../../../repo/types.ts';
import type { ProviderModelRecord } from '../../providers/types.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import type { LlmTargetApi, RequestContext } from '../interceptors.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { internalErrorResult, type ExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { ModelEndpoint, ProtocolFrame } from '@floway-dev/protocols/common';
import type { Mutable, ResponsesItemsView } from '@floway-dev/translate/via-responses/responses-items';

type Frame<TEvent> = ProtocolFrame<TEvent>;
export type Result<TEvent> = ExecuteResult<Frame<TEvent>>;

// Every way `serveLlm` can fail before producing a usable upstream result.
// These are protocol-agnostic: each source's `renderFailure` maps a failure to
// its own error envelope, so `LlmServeFailure` × source-protocol is a cartesian
// product. The failure carries only the minimum to render — never a pre-shaped
// body — because the body belongs to whichever protocol is answering.
//
// `item-not-found` re-creates a stored Responses item miss. Under the Responses
// protocol the gateway stands in for OpenAI's own item store, so the rendered
// body must byte-match OpenAI's native "not found" response (that exact shape
// lives in the Responses source); other protocols render the miss in their own
// envelope.
//
// `routing-unavailable` is gateway-invented — a stored item names an upstream
// that cannot serve the current model — so it has no external exact-body
// contract; its diagnosis text is built where the conflict is detected.
//
// `model-missing` / `model-unsupported` describe the provider walk finding no
// usable binding for the requested model. `internal` is an unexpected throw,
// surfaced as 5xx with a stack trace.
//
// Data corruption (a stored row whose item_type we no longer recognize) is NOT
// modeled here: it stays a plain Error and reaches the top-level catch as
// `internal`.
export type LlmServeFailure =
  | { kind: 'item-not-found'; itemId: string }
  | { kind: 'routing-unavailable'; message: string }
  | { kind: 'model-missing'; model: string }
  | { kind: 'model-unsupported'; model: string }
  | { kind: 'internal'; error: unknown };

// Carries a failure thrown from deep in request handling (e.g. a stored-item
// rewrite discovering an unsatisfiable reference) up to `serveLlm`, which maps
// it back into a `LlmServeFailure` for the source to render.
export class LlmServeFailureError extends Error {
  readonly failure: LlmServeFailure;

  constructor(failure: LlmServeFailure) {
    super(`LlmServeFailure: ${failure.kind}`);
    this.name = 'LlmServeFailureError';
    this.failure = failure;
  }
}

export const throwLlmServeFailure = (failure: LlmServeFailure): never => {
  throw new LlmServeFailureError(failure);
};

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, NonLlmServeApiName>;

// The base every source's `renderFailure` wraps: a synthetic `upstream-error`
// result carrying a gateway-built JSON body, so the respond layer renders a
// gateway-invented failure through the same path as a real upstream error.
export const jsonUpstreamErrorResult = (status: number, body: unknown): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
});

// Renders the `internal` failure kind shared by every source: a thrown upstream
// error passes through verbatim, otherwise the caught value becomes an
// internal-error result with a stack trace tagged to the source API.
export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
  },
): Result<TEvent> => {
  const upstreamError = thrownUpstreamErrorResult(error);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi));
};

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
