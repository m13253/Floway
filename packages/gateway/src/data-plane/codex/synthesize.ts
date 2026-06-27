// Synthesize a Codex `models.json`-shaped catalog entry for a Floway chat model
// that does not appear in the bundled Codex catalog. The shape matches what
// `openai/codex`'s OpenAiModelsManager deserializes; fields we do not
// opinionate on are filled with safe baselines.

import type { CatalogModel } from './catalog.ts';
import { SYNTHESIZED_BASE_INSTRUCTIONS } from './synthesized-base-instructions.ts';
import type { InternalModel, Modality } from '@floway-dev/provider';

const BASELINE_INPUT_MODALITIES: readonly Modality[] = ['text'];

// Registry-derived: each key in cost.tiers is a billable tier wire-id. Names
// mirror ids and descriptions are blank — Floway does not yet carry tier
// metadata, and Codex only needs the id to round-trip the selection.
export const deriveServiceTiers = (model: InternalModel): { id: string; name: string; description: string }[] =>
  Object.keys(model.cost?.tiers ?? {}).map(id => ({ id, name: id, description: '' }));

export const synthesizeCatalogEntry = (model: InternalModel): CatalogModel => {
  const inputModalities = model.chat?.modalities?.input ?? BASELINE_INPUT_MODALITIES;
  const hasImage = inputModalities.includes('image');
  // Lossy projection: Codex CLI's catalog wire can only model effort-tiered reasoning
  // (`supported_reasoning_levels: [{effort, description}]` + `default_reasoning_level`),
  // mirroring `codex-rs/protocol/src/openai_models.rs` ModelInfo fields
  // `supported_reasoning_levels: Vec<ReasoningEffortPreset>` and
  // `default_reasoning_level: Option<ReasoningEffort>`
  // (https://github.com/openai/codex/blob/b98870dc46c7b97a08b98e0fc39e85ccf36093c0/codex-rs/protocol/src/openai_models.rs).
  // Floway's `chat.reasoning` is richer: `budget_tokens`, `adaptive`, and `mandatory`
  // don't fit the Codex wire and are silently dropped here. The omission is benign at
  // request-time: Codex CLI sends `reasoning.effort` from the global default, and
  // Floway's translation layer maps that effort value into the appropriate upstream
  // representation (e.g. Anthropic `thinking.budget_tokens`). The catalog simply doesn't
  // surface effort pickers for models that don't support effort-tiered reasoning.
  const supportedReasoning = model.chat?.reasoning?.effort?.supported ?? [];
  const reasoningPresets = supportedReasoning.map(effort => ({ effort, description: '' }));

  // `context_window` / `max_context_window` are left off here — every entry's
  // window (including the conservative fallback for missing registry values)
  // is the responsibility of `applyContextWindowFromRegistry` in
  // context-window.ts, which is the single writer for the field.
  const entry: CatalogModel = {
    slug: model.id,
    display_name: model.display_name ?? model.id,
    description: '',
    truncation_policy: { mode: 'tokens', limit: 10000 },
    input_modalities: [...inputModalities],
    supports_image_detail_original: hasImage,
    web_search_tool_type: hasImage ? 'text_and_image' : 'text',
    supports_parallel_tool_calls: true,
    supported_reasoning_levels: reasoningPresets,
    shell_type: 'shell_command',
    support_verbosity: false,
    default_verbosity: null,
    prefer_websockets: true,
    supported_in_api: true,
    // ModelInfo (codex-rs/protocol/src/openai_models.rs) requires
    // `supports_reasoning_summaries: bool` and `apply_patch_tool_type:
    // Option<...>` to be present; absence aborts deserialization of the
    // whole `/models` body and codex silently falls back to its bundled
    // catalog — wiping out every synthesized entry.
    supports_reasoning_summaries: false,
    apply_patch_tool_type: null,
    default_reasoning_summary: 'none',
    base_instructions: SYNTHESIZED_BASE_INSTRUCTIONS,
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: deriveServiceTiers(model),
    priority: 0,
    visibility: 'list',
    availability_nux: null,
    upgrade: null,
    auto_compact_token_limit: null,
  };

  if (model.chat?.reasoning?.effort?.default !== undefined) {
    entry.default_reasoning_level = model.chat.reasoning.effort.default;
  }

  return entry;
};
