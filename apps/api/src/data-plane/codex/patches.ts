// Field overrides applied to upstream codex catalog entries before they
// are returned from `/azure-api.codex/models`.
//
// Keep this list small + reviewed. Each entry knowingly diverges from
// OpenAI's bundled default to enable a floway-specific behavior. The
// surrounding ModelInfo fields (base_instructions, model_messages,
// truncation_policy, web_search_tool_type, ...) are passed through
// untouched so floway tracks upstream codex behavior automatically when
// it changes between releases.

export interface ModelOverride {
  context_window?: number;
  max_context_window?: number;
  effective_context_window_percent?: number;
  auto_compact_token_limit?: number | null;
}

// gpt-5.5: advertise the 1M-context tier. codex's bundled catalog still
// caps gpt-5.5 at 272K because the v1 OpenAI 1p backend rejected larger
// windows; the Copilot upstream we wrap accepts the full 1.05M, so
// flip every gate to expose it.
//
//   effective_context_window_percent: codex multiplies context_window by
//     this percent (default 95) when computing `model_context_window` —
//     we set 100 so the advertised window lands exactly at 1.05M.
//   auto_compact_token_limit: codex defaults to 90% of resolved_context_window
//     when omitted, then clamps any explicit value to that ceiling. 945000
//     pins the trigger at exactly 90% rather than letting codex round on
//     its own.
export const CODEX_MODEL_OVERRIDES: Record<string, ModelOverride> = {
  'gpt-5.5': {
    context_window: 1050000,
    max_context_window: 1050000,
    effective_context_window_percent: 100,
    auto_compact_token_limit: 945000,
  },
};

interface CatalogModel {
  slug: string;
  [key: string]: unknown;
}

export interface CodexCatalog {
  models: CatalogModel[];
}

export const applyCodexOverrides = (catalog: CodexCatalog): CodexCatalog => ({
  models: catalog.models.map(model => {
    const override = CODEX_MODEL_OVERRIDES[model.slug];
    return override ? { ...model, ...override } : model;
  }),
});
