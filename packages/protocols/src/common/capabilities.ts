// Protocol-level model capability types, plus the kind-derivation that is
// intrinsic to them. Other runtime computation over these (path mapping,
// count-tokens augmentation) lives in apps/api/src/data-plane/providers/endpoints.ts.

import type { ModelKind } from './models.ts';

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

// Derive the high-level model kind from the supported endpoints. Each model
// belongs to exactly one kind. `embeddings` implies embedding,
// `imagesGenerations`/`imagesEdits` implies image, everything else is chat.
// Mixed endpoint sets (e.g. a model tagged with both `embeddings` and
// `chatCompletions`) are configuration errors; the first matching branch wins.
// `kind` is a pure projection of `endpoints`; routing never reads it.
export const kindForEndpoints = (endpoints: ModelEndpoints): ModelKind => {
  if (endpoints.embeddings) return 'embedding';
  if (endpoints.imagesGenerations || endpoints.imagesEdits) return 'image';
  return 'chat';
};
