import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';
import type { ProviderCandidate } from '../shared/candidates.ts';
import type { GatewayCtx } from '../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../responses/items/store.ts';

// Stub — replaced by Task 24. Exists so `responsesAttempt.generate`'s
// chat-completions-target branch can typecheck against the real signature.
export interface ChatCompletionsAttemptArgs {
  readonly payload: ChatCompletionsPayload;
  readonly ctx: GatewayCtx;
  readonly store: StatefulResponsesStore;
  readonly candidate: ProviderCandidate;
}

export const chatCompletionsAttempt = {
  generate: (_args: ChatCompletionsAttemptArgs): Promise<ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>> => {
    throw new Error('chatCompletionsAttempt.generate: not yet implemented (Task 24)');
  },
};
