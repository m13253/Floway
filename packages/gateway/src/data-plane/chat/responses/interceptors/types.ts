import type { TokenUsage } from '../../../../repo/types.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation as ProviderResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';

// App-side ResponsesInvocation extends the provider-package slim shape with
// the per-request stateful store. Provider interceptors only see the slim
// fields (parameter contravariance lets app-side richer instances flow in),
// while api-internal interceptors that need stored-item lookups read `store`.
// The `action` field on the provider shape is mutable through the chain;
// post-chain, `invocation.action` is the authoritative signal the gateway
// uses to pick snapshot mode and decide whether to drain the events into a
// single compaction envelope.
export interface ResponsesInvocation extends ProviderResponsesInvocation {
  readonly store: StatefulResponsesStore;
}

// The chain runner produces an event stream for both actions — the attempt
// post-processes it into a single `response.compaction` envelope only when
// the post-chain action is 'compact'. `modelIdentity` and `usage` carry the
// per-turn attribution forward so the http layer's `ctx.dump` records the
// success path identically to streaming generate.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: ResponsesResult;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
  };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
