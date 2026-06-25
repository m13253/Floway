/**
 * Closed enumeration of Floway protocol extension fields that the gateway
 * adds to each inbound IR on top of the host protocol's own schema. The
 * per-upstream sanitizer in the gateway reads this manifest to strip any
 * extension residue before the upstream HTTP call.
 */
export const FLOWAY_EXTENSION_FIELDS = {
  chatCompletions: ['thinking_budget', 'adaptive_thinking', 'reasoning_summary', 'anthropic_speed', 'anthropic_beta'] as const,
  responses: ['thinking_budget', 'adaptive_thinking', 'anthropic_speed', 'anthropic_beta'] as const,
  messages: ['verbosity'] as const,
  gemini: {
    topLevel: ['anthropicSpeed', 'anthropicBeta'] as const,
    generationConfig: ['verbosity', 'serviceTier'] as const,
  },
} as const;
