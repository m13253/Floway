// Synthesize a Codex `models.json`-shaped catalog entry for a Floway chat model
// that does not appear in the bundled Codex catalog. The shape matches what
// `openai/codex`'s OpenAiModelsManager deserializes; fields we do not
// opinionate on are filled with safe baselines.

import type { InternalModel, Modality } from '@floway-dev/provider';

const BASELINE_TRUNCATION = { mode: 'tokens', limit: 10000 } as const;
const BASELINE_INPUT_MODALITIES: readonly Modality[] = ['text'];

export const synthesizeCatalogEntry = (model: InternalModel): Record<string, unknown> => {
  const inputModalities = model.chat?.modalities?.input ?? BASELINE_INPUT_MODALITIES;
  const hasImage = inputModalities.includes('image');
  const supportedReasoning = model.chat?.reasoning?.supported_efforts ?? [];
  const reasoningPresets = supportedReasoning.map(effort => ({ effort, description: '' }));
  const contextWindow = model.limits.max_context_window_tokens;

  const entry: Record<string, unknown> = {
    slug: model.id,
    display_name: model.display_name ?? model.id,
    description: '',
    truncation_policy: BASELINE_TRUNCATION,
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
    reasoning_summary_format: 'none',
    default_reasoning_summary: 'none',
    base_instructions: '',
    effective_context_window_percent: 95,
    experimental_supported_tools: [],
    additional_speed_tiers: [],
    service_tiers: [],
    priority: 0,
    visibility: 'list',
    availability_nux: null,
    upgrade: null,
    auto_compact_token_limit: null,
  };

  if (contextWindow !== undefined) {
    entry.context_window = contextWindow;
    entry.max_context_window = contextWindow;
  }
  if (model.chat?.reasoning?.default_effort !== undefined) {
    entry.default_reasoning_level = model.chat.reasoning.default_effort;
  }

  return entry;
};
