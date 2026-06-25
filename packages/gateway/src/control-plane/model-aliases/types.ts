// Closed set of request-time mode knobs an operator can lock on a matched
// alias. Each value is freeform — the gateway does not enum-gate operator
// input so values pass through to upstream verbatim.
export type ModelAliasRules = {
  readonly reasoning?: {
    readonly effort?: string;
    readonly budgetTokens?: number;
    readonly adaptive?: boolean;
    readonly summary?: string;
  };
  readonly verbosity?: string;
  readonly serviceTier?: string;
  readonly anthropicSpeed?: string;
  readonly anthropicBeta?: readonly string[];
};

export type OnConflict = 'alias-only' | 'real-only' | 'both-real-first' | 'both-alias-first';

export type ModelAlias = {
  readonly alias: string;
  readonly targetModelId: string;
  readonly upstreamIds: readonly string[];
  readonly rules: ModelAliasRules;
  readonly visibleInModelsList: boolean;
  readonly onConflict: OnConflict;
  // Unix epoch seconds stamped at row insertion. Surfaced on the
  // `/v1/models` synthesized alias entry so callers see when an alias was
  // declared, matching the `created` semantics of the real entries.
  readonly createdAt: number;
};
