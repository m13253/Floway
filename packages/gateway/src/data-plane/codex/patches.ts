// Field overrides applied to upstream codex catalog entries before they
// are returned from `/azure-api.codex/models`.
//
// Each entry pairs a target slug with a known better catalog answer AND a
// minimum actual context the floway-side registry must advertise for that
// slug before we apply the override. The codex catalog speaks for the
// OpenAI 1p backend; floway's actual upstream (Copilot, custom, azure)
// may or may not match. Advertising values the upstream cannot honour
// would let codex send oversized requests we have no way to fulfil, so
// every override is gated on a registry confirmation of the slug's real
// limit.

import type { CodexCatalog } from './catalog.ts';

interface ModelOverride {
  context_window?: number;
  max_context_window?: number;
  auto_compact_token_limit?: number | null;
}

interface ConditionalOverride {
  override: ModelOverride;
  // Override fires only when the registry advertises at least this many
  // tokens of context for the slug; otherwise the catalog entry passes
  // through unchanged.
  minActualContextWindow: number;
}

// gpt-5.5 and gpt-5.4: advertise the 1M-context tier when floway's own
// registry says the slug actually has at least 1.05M of context. codex's
// bundled catalog pins context_window at 272000 for the v1 OpenAI 1p
// backend that rejected larger windows; both `context_window` and
// `max_context_window` flip together so the codex client lifts every
// derived gate to the full window.
//
//   auto_compact_token_limit: codex defaults to 90% of context_window
//     when this field is null, then clamps any explicit value to that
//     ceiling. 945000 pins the trigger at exactly 90% rather than letting
//     codex round on its own.
const ONE_M_CONDITIONAL: ConditionalOverride = {
  override: {
    context_window: 1050000,
    max_context_window: 1050000,
    auto_compact_token_limit: 945000,
  },
  minActualContextWindow: 1050000,
};

const CODEX_MODEL_OVERRIDES: Record<string, ConditionalOverride> = {
  'gpt-5.5': ONE_M_CONDITIONAL,
  'gpt-5.4': ONE_M_CONDITIONAL,
};

export type ContextWindowResolver = (slug: string) => number | null;

export const applyCodexOverrides = (catalog: CodexCatalog, actualContextWindowOf: ContextWindowResolver): CodexCatalog => ({
  models: catalog.models.map(model => {
    const entry = CODEX_MODEL_OVERRIDES[model.slug];
    if (entry === undefined) return model;
    const actual = actualContextWindowOf(model.slug);
    if (actual === null || actual < entry.minActualContextWindow) return model;
    return { ...model, ...entry.override };
  }),
});
