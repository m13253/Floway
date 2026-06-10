import type { ModelKind, ModelEndpoints, ModelPricing } from '@floway-dev/protocols/common';

export type UpstreamProviderKind = 'copilot' | 'custom' | 'azure' | 'codex';

// A provider's data instance — one row in the upstreams table. Pure data; the
// per-kind provider package validates `config` against its own schema.
export interface UpstreamRecord {
  id: string;
  provider: UpstreamProviderKind;
  name: string;
  enabled: boolean;
  sortOrder: number;
  createdAt: string;
  updatedAt: string;
  config: unknown;
  // Gateway-managed runtime state, persisted in upstreams.state_json. Null
  // for providers with no autonomous persistent state. Operator HTTP edits
  // never write this column; only the gateway's autonomous flows do.
  state: unknown;
  flagOverrides: Record<string, boolean>;
  // Public model ids the operator switched off for this upstream. Orthogonal to
  // every per-model metadata field and uniform across provider kinds: a disabled
  // id is hidden from the catalog and unroutable, but its row metadata stays
  // editable. Entries may reference ids no longer present in the live model list.
  disabledPublicModelIds: string[];
  // Ordered list of proxy ids (or the literal 'direct') the upstream falls back
  // through when its primary dial path is exhausted. Empty means no proxy
  // fallback configured. Persisted in the proxy_fallback_list_json column.
  proxyFallbackList: string[];
}

// Model identity attached to every provider result at the provider boundary
// so the identity is decided once.
export interface TelemetryModelIdentity {
  model: string;
  upstream: string;
  modelKey: string;
  cost: ModelPricing | null;
}

export interface PerformanceTelemetryContext {
  keyId: string;
  model: string;
  upstream: string | null;
  modelKey: string;
  stream: boolean;
  runtimeLocation: string;
}

// The internal model shape: what providers produce and what the registry
// stores. Provider-internal raw fields stay inside that provider's own
// types and projections; nothing upstream-shaped leaks onto this neutral
// type.
//
// `kind` is the high-level endpoint-family discriminator; `endpoints` (on
// UpstreamModel) is the precise per-protocol availability map. They are
// linked invariants enforced at the producer boundary:
//   `kind === 'embedding'` ⇔ `endpoints === { embeddings: {} }`
//   `kind === 'image'`     ⇔ `endpoints ⊂ {imagesGenerations, imagesEdits}`
//   `kind === 'chat'`      ⇒ `endpoints ⊂ generation endpoints`.
export interface InternalModel {
  id: string;
  display_name?: string;
  owned_by?: string;
  created?: number;
  limits: {
    max_output_tokens?: number;
    max_context_window_tokens?: number;
    max_prompt_tokens?: number;
  };
  kind: ModelKind;
  cost?: ModelPricing;
}

export interface UpstreamModel extends InternalModel {
  endpoints: ModelEndpoints;
  providerData?: unknown;
  enabledFlags: ReadonlySet<string>;
}
