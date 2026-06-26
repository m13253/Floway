import type { ChatCandidate, ProviderCandidate } from './candidates.ts';
import type { ChatServeFailure } from './errors.ts';

// Generic over the candidate type so call sites can narrow back to their
// concrete shape. The candidate filtering and ordering inside routing is
// shape-agnostic — it touches `binding.upstream` and
// `binding.supportsResponsesItemReference` only.
export type RoutingDecision<T extends ProviderCandidate = ChatCandidate> =
  | { readonly kind: 'success'; readonly candidates: readonly T[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
