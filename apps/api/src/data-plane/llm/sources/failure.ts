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
