import {
  CODEX_BACKEND_BASE,
  CODEX_CLI_VERSION,
  CODEX_MODELS_PATH,
  CODEX_ORIGINATOR,
  CODEX_USER_AGENT,
} from './constants.ts';
import { pricingForCodexModelKey } from './pricing.ts';
import { type Fetcher, type UpstreamModel } from '@floway-dev/provider';

export interface CodexRawModel {
  id: string;
  display_name: string;
  // Per-request hard context window.
  context_window: number;
  // Plan-level upper bound; used when context_window is unset.
  max_context_window: number;
}

// `fetcher` is required so the catalog refresh traverses the same proxy/
// dial chain configured for request-time traffic.
export const fetchCodexCatalog = async (opts: { accessToken: string; accountId: string; signal?: AbortSignal; fetcher: Fetcher }): Promise<CodexRawModel[]> => {
  const response = await opts.fetcher(`${CODEX_BACKEND_BASE}${CODEX_MODELS_PATH}?client_version=${CODEX_CLI_VERSION}`, {
    method: 'GET',
    headers: {
      authorization: `Bearer ${opts.accessToken}`,
      'chatgpt-account-id': opts.accountId,
      originator: CODEX_ORIGINATOR,
      'user-agent': CODEX_USER_AGENT,
      accept: 'application/json',
    },
    signal: opts.signal,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(`Codex /models fetch failed: ${response.status} ${body.slice(0, 200)}`);
  }
  const parsed = await response.json() as { models?: unknown };
  if (!Array.isArray(parsed.models)) throw new Error('Codex /models response missing models array');
  return parsed.models.map(assertRawModel);
};

const isPlainRecord = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

// Fail loud on malformed upstream catalog responses: a missing field
// signals an upstream contract change we need to notice, not a silent
// hole to paper over with a fabricated default.
const assertRawModel = (value: unknown): CodexRawModel => {
  if (!isPlainRecord(value)) throw new TypeError('Codex model entry is not an object');
  const slug = value.slug;
  if (typeof slug !== 'string') throw new TypeError(`Codex model entry missing slug: ${JSON.stringify(value).slice(0, 200)}`);
  const display_name = value.display_name;
  if (typeof display_name !== 'string') throw new TypeError(`Codex model entry ${slug} missing display_name`);
  const context_window = value.context_window;
  if (typeof context_window !== 'number') throw new TypeError(`Codex model entry ${slug} missing context_window`);
  const max_context_window = value.max_context_window;
  if (typeof max_context_window !== 'number') throw new TypeError(`Codex model entry ${slug} missing max_context_window`);
  return { id: slug, display_name, context_window, max_context_window };
};

// Codex exposes only the Responses endpoint. Pricing is looked up from the
// per-slug table in pricing.ts so the dashboard can report a notional
// API-rate cost even though Codex itself bills as a flat-fee subscription.
//
// `enabledFlags` is the upstream-resolved flag set (provider defaults
// merged with the row's `flagOverrides`); it propagates per-model so
// downstream interceptors can read the effective set without re-resolving.
export const codexRawToUpstreamModel = (raw: CodexRawModel, enabledFlags: ReadonlySet<string>): UpstreamModel => {
  const cost = pricingForCodexModelKey(raw.id);
  return {
    id: raw.id,
    display_name: raw.display_name,
    owned_by: 'openai',
    kind: 'chat',
    limits: {
      // Upstream uses 0 as the "unset" sentinel for the per-request window
      // (max_context_window remains the plan-level upper bound). Surface the
      // first positive value as the model's effective window; if both are
      // zero — unobserved in production — leave it unset.
      max_context_window_tokens: raw.context_window > 0 ? raw.context_window : raw.max_context_window > 0 ? raw.max_context_window : undefined,
    },
    endpoints: { responses: {} },
    enabledFlags,
    ...(cost ? { cost } : {}),
  };
};
