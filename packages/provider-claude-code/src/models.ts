// Anthropic exposes only the three model lines below to subscription clients;
// there is no `/v1/models` equivalent CC clients consult, so we ship the list
// inline rather than fetching it. The catalog stays small on purpose — the
// operator's upstream-model toggles operate on the public alias ids below.
//
// `id` is Anthropic's public alias (`claude-sonnet-4-5`); the dated revision
// the CC subscription currently maps the alias to lives under `providerData
// .upstreamModelId`. The gateway dispatch sees the alias as the catalog id and
// rewrites a dated-id request back to the alias via
// `resolveRequestedModelId`; the upstream fetch in `fetch.ts` reads
// `providerData.upstreamModelId` so Anthropic always sees a dated id and
// per-revision rate-limit / pricing routing stays accurate.
//
// Context window: Anthropic publishes 200k tokens for all current models
// (https://docs.claude.com/en/docs/about-claude/models/overview); we ship
// 1_000_000 for Sonnet to match the `context-1m` beta. Operators who run
// without that beta still get the 200k window enforced upstream-side.

import { pricingForClaudeCodeModelKey } from './pricing.ts';
import type { ClaudeCodeProviderData } from './types.ts';
import type { UpstreamModel } from '@floway-dev/provider';

interface ModelTemplate {
  alias: string;
  upstreamModelId: string;
  display_name: string;
  contextWindow: number;
}

const TEMPLATES: readonly ModelTemplate[] = [
  { alias: 'claude-sonnet-4-5', upstreamModelId: 'claude-sonnet-4-5-20250929', display_name: 'Claude Sonnet 4.5', contextWindow: 1_000_000 },
  { alias: 'claude-opus-4-5', upstreamModelId: 'claude-opus-4-5-20251101', display_name: 'Claude Opus 4.5', contextWindow: 200_000 },
  { alias: 'claude-haiku-4-5', upstreamModelId: 'claude-haiku-4-5-20251001', display_name: 'Claude Haiku 4.5', contextWindow: 200_000 },
];

const buildModel = (template: ModelTemplate, enabledFlags: ReadonlySet<string>): UpstreamModel => {
  const cost = pricingForClaudeCodeModelKey(template.upstreamModelId);
  const providerData: ClaudeCodeProviderData = { upstreamModelId: template.upstreamModelId };
  return {
    id: template.alias,
    display_name: template.display_name,
    owned_by: 'anthropic',
    kind: 'chat',
    endpoints: { messages: {} },
    enabledFlags,
    limits: { max_context_window_tokens: template.contextWindow },
    providerData,
    ...(cost ? { cost } : {}),
  };
};

export const buildClaudeCodeModels = (enabledFlags: ReadonlySet<string>): UpstreamModel[] =>
  TEMPLATES.map(template => buildModel(template, enabledFlags));

// Dated-id → alias map derived from the catalog at module load. The dispatch
// hook needs both directions (request-side: dated → alias; wire-side:
// alias → dated) and the latter lives on the model's providerData. Keeping
// the request-side map here avoids re-parsing every dated id at lookup time.
const ALIAS_BY_UPSTREAM_ID: ReadonlyMap<string, string> = new Map(
  TEMPLATES.map(template => [template.upstreamModelId, template.alias]),
);

const ALIASES: ReadonlySet<string> = new Set(TEMPLATES.map(template => template.alias));

// Pattern: claude-(haiku|opus|sonnet)-<digit>-<digit>-<YYYYMMDD>. Restricted to
// the families we ship so a future model line does not silently resolve to a
// missing alias before its catalog entry lands.
const DATED_MODEL_RE = /^claude-(?:haiku|opus|sonnet)-\d+-\d+-\d{8}$/;

// Hook for `ModelProviderInstance.resolveRequestedModelId`: when a client
// addresses one of our models by its dated id (`claude-sonnet-4-5-20250929`),
// resolve it to the catalog alias (`claude-sonnet-4-5`). The upstream id the
// dated request would have hit is the same one this alias resolves to via
// `providerData.upstreamModelId`, so the wire call stays unchanged.
export const claudeCodeResolveRequestedModelId = (modelId: string): string | undefined => {
  // Already an alias, or unknown id family — nothing to resolve.
  if (ALIASES.has(modelId)) return undefined;
  if (!DATED_MODEL_RE.test(modelId)) return undefined;
  const alias = ALIAS_BY_UPSTREAM_ID.get(modelId);
  return alias;
};
