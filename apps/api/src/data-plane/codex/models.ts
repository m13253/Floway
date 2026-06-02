// codex-internal `/models` shape.
//
// codex reads this via `OpenAiModelsManager::list_models` and replaces its
// bundled catalog when AuthMode is Chatgpt / ChatgptAuthTokens /
// AgentIdentity. The wire shape is codex's own `ModelsResponse`
// (`{"models": [ModelInfo, ...]}`), not the OpenAI public catalog
// (`{"object":"list","data":[...]}`) we serve at `/v1/models`.
//
// The gpt-5.5 entry below is copied verbatim from codex's bundled
// `models-manager/models.json` (Apache 2.0, openai/codex,
// https://github.com/openai/codex/blob/main/codex-rs/models-manager/models.json)
// with four numeric fields patched to advertise the 1M-context tier:
//
//   context_window:                    272000 -> 1050000
//   max_context_window:                272000 -> 1050000
//   effective_context_window_percent:      95 ->     100
//   auto_compact_token_limit:            null ->  945000
//
// We hold the entry whole rather than reconstruct ModelInfo from
// floway's InternalModel because the struct carries codex-specific
// behavioral fields (base_instructions, model_messages.instructions_template,
// truncation_policy, web_search_tool_type, supports_image_detail_original,
// reasoning_summary_format, ...) that have no analog in the OpenAI public
// catalog. Reconstructing them risks subtle behavior drift across codex
// releases; copying preserves OpenAI's own current values.

import type { Context } from 'hono';

import gpt55 from './catalog/gpt-5.5.json' with { type: 'json' };

const codexCatalog = {
  models: [gpt55],
};

export const codexModels = (_c: Context): Response => Response.json(codexCatalog);
