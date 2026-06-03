// Logical endpoint keys used by the gateway-internal upstream dispatcher.
// Each provider package owns its own path resolution per key; this enum is the
// single shared vocabulary the api uses when asking a provider to issue a call
// at a named endpoint (registry probes, route mounts, etc.).
// `messages_count_tokens` is intentionally a logical key: it is a sub-path of
// `messages` and follows the same provider-owned path policy, so the UI never
// exposes it as a separate configurable endpoint.
export type EndpointKey = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings' | 'images_generations' | 'images_edits' | 'models';

export type UpstreamKind = 'copilot' | 'custom' | 'azure';

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
}

// Endpoints that the gateway always invokes as Server-Sent Events. The data
// plane treats SSE as the only upstream transport for these endpoints; providers
// inject `stream: true` so middle layers never observe a non-streaming variant.
// `messages_count_tokens` and `embeddings` remain non-streaming JSON.
export const isStreamingEndpoint = (endpoint: EndpointKey): boolean =>
  endpoint === 'chat_completions' || endpoint === 'responses' || endpoint === 'messages';
