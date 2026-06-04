import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ChatCompletionsPayload, ChatCompletionsStreamEvent } from '@floway-dev/protocols/chat-completions';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ChatCompletionsInvocation {
  payload: ChatCompletionsPayload;
  readonly candidate: ProviderCandidate;
  // `headers` is the mutable HTTP-header bag the attempt seeds empty and
  // target-portable interceptors populate; the provider's upstream call passes
  // it through to the wire fetch unchanged. Kept aligned with
  // `MessagesInvocation.headers` so future Copilot interceptors that share
  // implementations across protocols can mutate the same shape regardless of
  // which source emitted the request.
  readonly headers: Record<string, string>;
}

export type ChatCompletionsInterceptor = Interceptor<
  ChatCompletionsInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ChatCompletionsStreamEvent>>
>;
