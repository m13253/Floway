// Logical endpoint keys used by the gateway-internal upstream dispatcher.
// Each provider package owns its own path resolution per key; this enum is the
// single shared vocabulary the api uses when asking a provider to issue a call
// at a named endpoint (registry probes, route mounts, etc.).
// `messages_count_tokens` is intentionally a logical key: it is a sub-path of
// `messages` and follows the same provider-owned path policy, so the UI never
// exposes it as a separate configurable endpoint.
export type EndpointKey = 'chat_completions' | 'responses' | 'messages' | 'messages_count_tokens' | 'embeddings' | 'images_generations' | 'images_edits' | 'models';

// Subset of EndpointKey whose calls go over SSE. Provider implementations
// type their callStreaming helpers with this so the literal union stays in
// sync with `isStreamingEndpoint` below.
export type StreamingEndpointKey = 'chat_completions' | 'responses' | 'messages';

export interface UpstreamFetchOptions {
  extraHeaders?: Record<string, string>;
}

// Endpoints that the gateway always invokes as Server-Sent Events. The data
// plane treats SSE as the only upstream transport for these endpoints; providers
// inject `stream: true` so middle layers never observe a non-streaming variant.
// `messages_count_tokens` and `embeddings` remain non-streaming JSON.
export const isStreamingEndpoint = (endpoint: EndpointKey): endpoint is StreamingEndpointKey =>
  endpoint === 'chat_completions' || endpoint === 'responses' || endpoint === 'messages';
