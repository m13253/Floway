import type { UpstreamModelConfig } from '../../shared/upstream/model-config.ts';
import type { EndpointKey } from '../../shared/upstream/types.ts';
import type { LlmTargetApi } from '../llm/interceptors.ts';
import type { ModelEndpointKey, ModelEndpoints, ModelKind } from '@floway-dev/protocols/common';

export const llmTargetApiToModelEndpoint = (target: LlmTargetApi): ModelEndpointKey => {
  switch (target) {
  case 'messages':
    return 'messages';
  case 'responses':
    return 'responses';
  case 'chat-completions':
    return 'chatCompletions';
  }
};

// Endpoints that the gateway always invokes as Server-Sent Events. The data
// plane treats SSE as the only upstream transport for these endpoints; providers
// inject `stream: true` so middle layers never observe a non-streaming variant.
// `messages_count_tokens` and `embeddings` remain non-streaming JSON.
export const isStreamingEndpoint = (endpoint: EndpointKey): boolean =>
  endpoint === 'chat_completions' || endpoint === 'responses' || endpoint === 'messages';

// Derive the high-level model kind from the supported endpoints. Each model
// belongs to exactly one kind. `embeddings` implies embedding,
// `imagesGenerations`/`imagesEdits` implies image, everything else is chat.
// Mixed endpoint sets (e.g. an upstream incorrectly tagging a model with both
// `embeddings` and `chatCompletions`) are configuration errors; the first
// matching branch wins.
export const kindForEndpoints = (endpoints: ModelEndpoints): ModelKind => {
  if (endpoints.embeddings) return 'embedding';
  if (endpoints.imagesGenerations || endpoints.imagesEdits) return 'image';
  return 'chat';
};

// `messages.countTokens` is not operator-configured: it is derived here whenever
// `messages` is present so the count-tokens endpoint routes alongside it.
export const withMessagesCountTokens = (endpoints: ModelEndpoints): ModelEndpoints =>
  endpoints.messages ? { ...endpoints, messages: { ...endpoints.messages, countTokens: true } } : { ...endpoints };

// A manually configured model declares its structured `endpoints` directly; we
// only derive the `messages.countTokens` sub-capability on top.
export const modelConfigEndpoints = (model: UpstreamModelConfig): ModelEndpoints =>
  withMessagesCountTokens(model.endpoints);
