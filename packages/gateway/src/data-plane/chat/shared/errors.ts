// Failures a protocol can render before reaching an upstream; unexpected
// throws bubble as-is. `failedUpstreams` on model-{missing,unsupported}
// carries the upstream names whose catalog fetch threw during this
// resolution — surfaced parenthetically so the caller can tell a genuine
// "no upstream has this model" miss from a transient outage where the
// upstream that owns the model is currently unreachable. An empty array
// means every consulted upstream returned a catalog.
export type ChatServeFailure =
  | { readonly kind: 'model-missing'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'model-unsupported'; readonly model: string; readonly failedUpstreams: readonly string[] }
  | { readonly kind: 'item-not-found'; readonly itemId: string }
  | { readonly kind: 'routing-unavailable'; readonly message: string };

class ChatServeFailureError extends Error {
  readonly failure: ChatServeFailure;

  constructor(failure: ChatServeFailure) {
    super(`ChatServeFailure: ${failure.kind}`);
    this.failure = failure;
  }
}

export const throwChatServeFailure = (failure: ChatServeFailure): never => {
  throw new ChatServeFailureError(failure);
};

export const tryCatchChatServeFailure = (error: unknown): ChatServeFailure | null =>
  error instanceof ChatServeFailureError ? error.failure : null;

// Type guard for the narrowing planners' `T[] | ChatServeFailure` return
// shape. `Array.isArray` does narrow this union in most TS versions, but
// not all — using a named predicate keeps the call sites readable and
// independent of that quirk.
export const isChatServeFailure = (value: unknown): value is ChatServeFailure =>
  value !== null && typeof value === 'object' && !Array.isArray(value) && 'kind' in value;
