// Pure protocol-level capability types. Runtime computation lives in
// apps/api/src/data-plane/providers/endpoints.ts which consumes these.

// The Responses endpoint's sub-capabilities. `compact` means the upstream
// serves the native `/responses/compact` endpoint; `contextManagement` means it
// honours the `context_management` parameter on `/responses`. The gateway can
// realize client-facing compaction through either, so externally it advertises
// `compact || contextManagement` as a single compaction capability.
export interface ResponsesEndpoint {
  compact?: boolean;
  contextManagement?: boolean;
}

// Structured per-endpoint capability map. A key being present means the model
// is served by that endpoint; its value object carries that endpoint's
// sub-capabilities. `responses.compact` / `responses.contextManagement` and
// `messages.countTokens` are auxiliary sub-paths of their primary endpoint, not
// independently advertised endpoints.
export interface ModelEndpoints {
  chatCompletions?: {};
  responses?: ResponsesEndpoint;
  messages?: { countTokens?: boolean };
  embeddings?: {};
  imagesGenerations?: {};
  imagesEdits?: {};
}

// Names a single endpoint within ModelEndpoints — used where one endpoint is
// addressed by identity rather than as a presence map.
export type ModelEndpointKey = keyof ModelEndpoints;
