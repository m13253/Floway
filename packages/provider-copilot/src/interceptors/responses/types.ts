import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesPayload, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, UpstreamModel } from '@floway-dev/provider';

// Boundary ctx for Copilot Responses interceptors. See messages/types.ts for
// the boundary-isolation rationale; the shape mirrors the Messages boundary
// minus `anthropicBeta` (Responses has no upstream beta-flag input).
export interface ResponsesBoundaryCtx {
  payload: ResponsesPayload;
  headers: Record<string, string>;
  readonly model: UpstreamModel;
}

export type CopilotResponsesBoundaryInterceptor = Interceptor<
  ResponsesBoundaryCtx,
  object,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
