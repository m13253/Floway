// Every way a protocol's serve/attempt can fail before producing a usable
// upstream result. Protocol-agnostic on purpose: each protocol's
// `renderXFailure` maps a failure to its own error envelope, so a failure
// carries only the minimum to render — never a pre-shaped body.
//
// `model-missing` / `model-unsupported` describe the candidate walk finding no
// usable binding for the requested model.
//
// `item-not-found` re-creates a stored Responses item miss; under the Responses
// protocol the gateway stands in for OpenAI's own item store, so the rendered
// body must byte-match OpenAI's native "not found" response. Other protocols
// render the miss in their own envelope.
//
// `routing-unavailable` is gateway-invented — a stored item names an upstream
// that cannot serve the current model — so it has no external exact-body
// contract; its diagnosis text is built where the conflict is detected.
//
// `item-not-found` and `routing-unavailable` originate only inside the
// Responses-domain helpers (`classifyResponsesItemAffinity` and
// `rewriteResponsesItemsForCandidate`); they propagate to whichever
// source-protocol invoked those helpers.
//
// Unexpected throws (data corruption, provider crashes) are NOT modeled here:
// they bubble to the top-level catch as plain errors with a stack trace.
export type LlmServeFailure =
  | { kind: 'model-missing'; model: string }
  | { kind: 'model-unsupported'; model: string }
  | { kind: 'item-not-found'; itemId: string }
  | { kind: 'routing-unavailable'; message: string };

// Carrier for a failure thrown synchronously from deep inside request handling
// (e.g. `rewriteResponsesItemsForCandidate` discovering an unsatisfiable
// `item_reference`). `responsesAttempt` catches it and converts it back into
// an `ExecuteResult` failure via `tryCatchLlmServeFailure`.
class LlmServeFailureError extends Error {
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

export const tryCatchLlmServeFailure = (error: unknown): LlmServeFailure | null =>
  error instanceof LlmServeFailureError ? error.failure : null;
