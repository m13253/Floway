// Field overrides applied to upstream codex catalog entries before they
// are returned from `/azure-api.codex/models`.
//
// Keep this list small + reviewed. Each entry knowingly diverges from
// OpenAI's bundled default to enable a floway-specific behavior. The
// surrounding ModelInfo fields (base_instructions, model_messages,
// truncation_policy, web_search_tool_type, ...) are passed through
// untouched so floway tracks upstream codex behavior automatically when
// it changes between releases.

import type { CodexCatalog } from './catalog.ts';

interface ModelOverride {
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  auto_compact_token_limit?: number | null;
}

// gpt-5.5 and gpt-5.4: advertise the 1M-context tier the Copilot upstream
// publishes for both (1,050,000 / 922,000 prompt). codex's bundled catalog
// pins context_window at 272000 for the v1 OpenAI 1p backend that rejected
// larger windows; flipping every gate exposes the full window through floway.
//
//   effective_context_window_percent: codex multiplies context_window by
//     this percent (default 95) when computing `model_context_window` —
//     we set 100 so the advertised window lands exactly at 1.05M.
//   auto_compact_token_limit: codex defaults to 90% of resolved_context_window
//     when omitted, then clamps any explicit value to that ceiling. 945000
//     pins the trigger at exactly 90% rather than letting codex round on
//     its own.
const ONE_M_OVERRIDE: ModelOverride = {
  context_window: 1050000,
  max_context_window: 1050000,
  effective_context_window_percent: 100,
  auto_compact_token_limit: 945000,
};

const CODEX_MODEL_OVERRIDES: Record<string, ModelOverride> = {
  'gpt-5.5': ONE_M_OVERRIDE,
  'gpt-5.4': ONE_M_OVERRIDE,
};

export const applyCodexOverrides = (catalog: CodexCatalog): CodexCatalog => ({
  models: catalog.models.map(model => {
    const override = CODEX_MODEL_OVERRIDES[model.slug];
    return override ? { ...model, ...override } : model;
  }),
});
