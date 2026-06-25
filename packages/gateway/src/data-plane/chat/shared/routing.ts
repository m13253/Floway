import type { ChatCandidate, ProviderCandidate } from './candidates.ts';
import type { ChatServeFailure } from './errors.ts';

// Generic over the candidate type so call sites that hand in `ChatCandidate`
// receive a decision whose surviving candidates retain the alias metadata.
// The candidate filtering and ordering inside routing is shape-agnostic —
// it touches `binding.upstream` and `binding.supportsResponsesItemReference`
// only — so the generic narrows naturally from `ChatCandidate` back out
// without re-deriving the alias fields.
export type RoutingDecision<T extends ProviderCandidate = ChatCandidate> =
  | { readonly kind: 'success'; readonly candidates: readonly T[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
