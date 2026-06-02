// Pure protocol-level capability types. Runtime computation lives in
// apps/api/src/data-plane/providers/endpoints.ts which consumes these.

// Structured per-endpoint capability map. A key being present means the model
// is served by that endpoint; its value object carries that endpoint's
// sub-capabilities. `responses.compact` / `responses.contextManagement` and
// `messages.countTokens` are auxiliary sub-paths of their primary endpoint, not
// independently advertised endpoints.
export interface ModelEndpoints {
  chatCompletions?: {};
  responses?: { compact?: boolean; contextManagement?: boolean };
  messages?: { countTokens?: boolean };
  embeddings?: {};
  imagesGenerations?: {};
  imagesEdits?: {};
}

// Names a single endpoint within ModelEndpoints — used where one endpoint is
// addressed by identity rather than as a presence map.
export type ModelEndpointKey = keyof ModelEndpoints;

export interface ModelCapabilities {
  maxOutputTokens?: number;
  supportedEndpoints: ModelEndpoints;
}
