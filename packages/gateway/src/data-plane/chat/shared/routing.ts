import type { ChatPlanItem } from './candidates.ts';
import type { ChatServeFailure } from './errors.ts';

export type RoutingDecision =
  | { readonly kind: 'success'; readonly candidates: readonly ChatPlanItem[] }
  | { readonly kind: 'failure'; readonly failure: ChatServeFailure };
