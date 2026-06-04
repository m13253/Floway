import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import type { GatewayCtx } from '../../shared/gateway-ctx.ts';
import type { ProviderCandidate } from '../../shared/candidates.ts';
import type { StatefulResponsesStore } from '../items/store.ts';

export interface ResponsesInvocation {
  payload: ResponsesPayload;
  readonly candidate: ProviderCandidate;
  readonly store: StatefulResponsesStore;
}

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  GatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
