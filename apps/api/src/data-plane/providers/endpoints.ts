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

const ENDPOINT_TO_PUBLIC_PATH: Record<ModelEndpointKey, string> = {
  chatCompletions: '/chat/completions',
  responses: '/responses',
  messages: '/v1/messages',
  embeddings: '/embeddings',
  imagesGenerations: '/images/generations',
  imagesEdits: '/images/edits',
};

export const modelEndpointToPublicPath = (endpoint: ModelEndpointKey): string => ENDPOINT_TO_PUBLIC_PATH[endpoint];

export const publicPathToModelEndpoint = (path: string): ModelEndpointKey | undefined => {
  switch (path) {
  case '/chat/completions':
  case '/v1/chat/completions':
    return 'chatCompletions';
  case '/responses':
  case '/v1/responses':
    return 'responses';
  case '/v1/messages':
  case '/messages':
    return 'messages';
  case '/embeddings':
  case '/v1/embeddings':
    return 'embeddings';
  case '/images/generations':
  case '/v1/images/generations':
    return 'imagesGenerations';
  case '/images/edits':
  case '/v1/images/edits':
    return 'imagesEdits';
  default:
    return undefined;
  }
};

export const publicPathsToModelEndpoints = (paths: readonly string[]): ModelEndpoints => {
  const endpoints: ModelEndpoints = {};
  for (const path of paths) {
    const endpoint = publicPathToModelEndpoint(path);
    if (endpoint) endpoints[endpoint] ??= {};
  }
  return endpoints;
};

// Lists the public paths for the present endpoint keys. Auxiliary sub-caps
// (compact / contextManagement / countTokens) share a primary endpoint's input
// and are not advertised as standalone model paths.
export const modelEndpointsToPublicPaths = (endpoints: ModelEndpoints): string[] =>
  (Object.keys(endpoints) as ModelEndpointKey[]).map(modelEndpointToPublicPath);

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

// A manually configured model declares only its chat-protocol availability via
// `supportedEndpoints`. We augment with `messages.countTokens` whenever
// `messages` is present so the count-tokens endpoint routes alongside it without
// the operator having to list it explicitly.
export const withMessagesCountTokens = (endpoints: ModelEndpoints): ModelEndpoints =>
  endpoints.messages ? { ...endpoints, messages: { ...endpoints.messages, countTokens: true } } : { ...endpoints };

// A manually configured model declares its chat-protocol availability via
// `supportedEndpoints` and, for Responses, its compaction sub-capabilities via
// `responses`. We augment with `messages.countTokens` whenever `messages` is
// present so the count-tokens endpoint routes alongside it without the operator
// having to list it explicitly, and fold the operator-declared Responses
// sub-capabilities onto the `responses` endpoint when it is present.
export const modelConfigEndpoints = (model: UpstreamModelConfig): ModelEndpoints => {
  const endpoints = withMessagesCountTokens(publicPathsToModelEndpoints(model.supportedEndpoints));
  if (endpoints.responses && model.responses) endpoints.responses = { ...endpoints.responses, ...model.responses };
  return endpoints;
};
