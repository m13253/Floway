import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ExecuteResult } from '@floway-dev/provider';

export interface MessagesInvocation {
  payload: MessagesPayload;
  readonly candidate: ProviderCandidate;
  // `anthropicBeta` is an inbound Messages concept that crosses native
  // Messages targets; translated targets (Responses, Chat Completions) do not
  // consume it, so it stays optional and is only populated when the source
  // protocol is Messages and the target is Messages.
  readonly anthropicBeta?: readonly string[];
  // `headers` is the mutable HTTP-header bag the source serve seeds empty and
  // target-portable interceptors populate; the provider's upstream call passes
  // it through to the wire fetch unchanged. Shared by reference across
  // translated emit closures so a single source-side mutation lands on the
  // upstream HTTP call regardless of which target the planner picked.
  readonly headers: Record<string, string>;
}

export type MessagesInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<MessagesStreamEvent>>
>;

// count_tokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns the raw upstream `Response` directly, with no protocol-frame
// translation in between. The interceptor chain still runs against a
// `MessagesInvocation` so payload-shaped reads (vision detection, last-message
// initiator classification, anthropic-beta filtering) match the chat path
// exactly. Interceptors registered here MUST be pure header/payload mutators;
// post-`run()` result inspection is not portable to this result type.
export type MessagesCountTokensInterceptor = Interceptor<
  MessagesInvocation,
  GatewayCtx,
  Response
>;
