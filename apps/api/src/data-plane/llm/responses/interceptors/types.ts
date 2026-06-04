import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { StatefulResponsesStore } from '../items/store.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  readonly candidate: ProviderCandidate;
  readonly store: StatefulResponsesStore;
  // `headers` is the mutable HTTP-header bag the source serve seeds empty and
  // target-portable interceptors populate; the provider's upstream call passes
  // it through to the wire fetch unchanged. Shared by reference across
  // translated emit closures so a single source-side mutation lands on the
  // upstream HTTP call regardless of which target the planner picked.
  readonly headers: Record<string, string>;
}

// Compact post-processes the chain's event stream into a single
// `response.compaction` envelope and returns it as a value; generate keeps
// the events branch. The chain runner itself stays narrow over
// `ExecuteResult<…ResponsesStreamEvent>` so existing interceptors retain
// their event-stream contract — the result branch is observable only on
// `responsesAttempt.compact`'s outer return.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | { readonly type: 'result'; readonly result: ResponsesResult };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
