import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';

// Stub — replaced by Task 23. Exists so `responsesAttempt.generate`'s
// messages-target branch can typecheck against the real signature.
export interface MessagesAttemptArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
}

export interface MessagesCountTokensAttemptArgs {
  readonly payload: MessagesPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
  readonly anthropicBeta?: readonly string[];
}

export const messagesAttempt = {
  generate: (_args: MessagesAttemptArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    throw new Error('messagesAttempt.generate: not yet implemented (Task 23)');
  },
  countTokens: (_args: MessagesCountTokensAttemptArgs): Promise<ExecuteResult<ProtocolFrame<MessagesStreamEvent>>> => {
    throw new Error('messagesAttempt.countTokens: not yet implemented (Task 23)');
  },
};
