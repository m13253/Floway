import type { ModelEndpoints } from '@floway-dev/protocols/common';
import type { ChatTargetApi, ProviderCandidate } from '@floway-dev/provider';

// Re-export here so chat call sites do not have to know that the
// underlying type lives in `@floway-dev/provider`. Tests and serves
// already import `ProviderCandidate` from this module; keeping the alias
// avoids a sprawling import-rewrite that would obscure the actual
// candidate-shape change.
export type { ProviderCandidate };

// Pairs a resolved candidate with the chat target protocol the calling
// serve picked for it. Chat dispatch operates on these pairs end-to-end:
// the planner reorders them by routing affinity, the attempt layer
// receives one and switches on `targetApi` to choose between the native
// wire call and a translation-shim path.
export interface ChatPlanItem {
  readonly candidate: ProviderCandidate;
  readonly targetApi: ChatTargetApi;
}

// Map raw chat-kind candidates to plan items by running each candidate's
// `model.endpoints` through the caller's inbound-protocol preference
// picker. Candidates whose endpoints don't satisfy any preference are
// dropped — they cannot serve the current operation, so dispatching to
// them would be a guaranteed failure. The picker's null return is the
// failover signal; we apply it ahead of the planner so a non-routable
// candidate never reaches affinity reordering.
export const planChatCandidates = (
  candidates: readonly ProviderCandidate[],
  pickTarget: (endpoints: ModelEndpoints) => ChatTargetApi | null,
): readonly ChatPlanItem[] => {
  const items: ChatPlanItem[] = [];
  for (const candidate of candidates) {
    const targetApi = pickTarget(candidate.model.endpoints);
    if (targetApi !== null) items.push({ candidate, targetApi });
  }
  return items;
};
