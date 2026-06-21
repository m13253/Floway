import type { InternalDebugError } from './error.ts';
import type { PerformanceTelemetryContext, TelemetryModelIdentity } from './model.ts';

export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  // Raw upstream response headers for the source-side `respond` layer to
  // forward (blocklist in gateway `shared/respond.ts`). Absent on
  // lifted/synthesized streams that have no upstream Response behind them.
  headers?: Headers;
}

export interface EventResultMetadata {
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
}

export interface UpstreamErrorResult {
  type: 'upstream-error';
  status: number;
  headers: Headers;
  body: Uint8Array;
  performance?: PerformanceTelemetryContext;
}

export interface InternalErrorResult {
  type: 'internal-error';
  status: number;
  error: InternalDebugError;
  performance?: PerformanceTelemetryContext;
}

// A fully-shaped non-streaming success body — the output of a source endpoint
// that measures rather than generates (count_tokens). It is NOT an
// `ExecuteResult`: the target emit/interceptor layer never produces one. The
// orchestrator passes it straight to `respond` without persistence, and
// `respond` emits it verbatim.
export interface PlainResult {
  type: 'plain';
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export type ExecuteResult<T> = EventResult<T> | UpstreamErrorResult | InternalErrorResult;

export interface EventResultOptions {
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
  headers?: Headers;
}

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  options: EventResultOptions = {},
): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (options.performance !== undefined) result.performance = options.performance;
  if (options.finalMetadata !== undefined) result.finalMetadata = options.finalMetadata;
  if (options.headers !== undefined) result.headers = options.headers;
  return result;
};

export const internalErrorResult = (status: number, error: InternalDebugError, performance?: PerformanceTelemetryContext): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  ...(performance ? { performance } : {}),
});

export const plainResult = (status: number, headers: Headers, body: Uint8Array): PlainResult => ({ type: 'plain', status, headers, body });

export const readUpstreamError = async (response: Response): Promise<UpstreamErrorResult> => ({
  type: 'upstream-error',
  status: response.status,
  headers: new Headers(response.headers),
  body: new Uint8Array(await response.arrayBuffer()),
});

export const upstreamErrorToResponse = (error: UpstreamErrorResult): Response =>
  new Response(error.body.slice().buffer, {
    status: error.status,
    headers: new Headers(error.headers),
  });

export const decodeUpstreamErrorBody = (error: UpstreamErrorResult): string => new TextDecoder().decode(error.body);
