// Per-model pricing in USD per million tokens, aligned with the sst/models.dev
// `Cost` schema (https://github.com/sst/models.dev/blob/main/packages/core/src/schema.ts).
// Extensions follow that schema's field names (`reasoning`, `input_audio`,
// `output_audio`, etc.) when they are added.
export interface ModelPricing {
  input: number;
  output: number;
  cache_read?: number;
  cache_write?: number;
}

// High-level endpoint-family discriminator. A model belongs to exactly one
// kind; cross-cutting features (vision, function calling, structured outputs)
// are orthogonal and modeled separately when needed.
//
// Convention borrowed from Together AI's `type` field on /models
// (https://docs.together.ai/reference/models-1): a single string enum is
// the cleanest signal across providers, since each model id in practice maps
// to one endpoint family (OpenAI gpt-* vs text-embedding-*; Cohere command-*
// vs embed-*; Voyage's catalog is all embeddings; Mistral mistral-large vs
// mistral-embed; etc.). We renamed `type` to `kind` to avoid colliding with
// Anthropic's `type: 'model'` object discriminator already on PublicModel.
//
// Extend with 'audio_transcription' | 'audio_speech' | 'image_generation' |
// 'moderation' | 'rerank' if/when the gateway routes those endpoint families.
export type ModelKind = 'chat' | 'embedding';

// Public DTO served at /v1/models and /models. Single superset shape — OpenAI's
// and Anthropic's /models field names do not overlap, so one payload satisfies
// both client shapes.
export interface PublicModel {
  // OpenAI fields
  id: string;
  object: 'model';
  owned_by?: string;
  created?: number;
  // Anthropic fields
  type: 'model';
  display_name: string;
  created_at?: string;
  // Non-standard extra fields below.
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface PublicModelsResponse {
  // OpenAI container
  object: 'list';
  // Anthropic container
  has_more: false;
  first_id: string | null;
  last_id: string | null;
  data: PublicModel[];
}
