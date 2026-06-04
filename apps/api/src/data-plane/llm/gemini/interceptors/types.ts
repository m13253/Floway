import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { ExecuteResult, PlainResult } from '@floway-dev/provider';

export interface GeminiInvocation {
  payload: GeminiPayload;
  readonly candidate: ProviderCandidate;
  // `headers` is the mutable HTTP-header bag the source serve seeds empty and
  // target-portable interceptors populate; the provider's upstream call passes
  // it through to the wire fetch unchanged. Shared by reference across
  // translated emit closures so a single source-side mutation lands on the
  // upstream HTTP call regardless of which target the planner picked.
  readonly headers: Record<string, string>;
}

export type GeminiInterceptor = Interceptor<
  GeminiInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<GeminiStreamEvent>>
>;

// countTokens is a one-shot, non-streaming HTTP exchange — the terminal
// returns a `PlainResult` carrying the reshaped Gemini envelope, not an event
// stream. The interceptor chain still runs against a `GeminiInvocation` so
// payload-shaped reads stay symmetric with the generate path. Interceptors
// registered here MUST be pure header/payload mutators; post-`run()` result
// inspection is not portable to this result type.
export type GeminiCountTokensInterceptor = Interceptor<
  GeminiInvocation,
  GatewayCtx,
  PlainResult
>;
