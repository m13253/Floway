import type { InternalDebugError } from './internal-debug-error.ts';
import type { TelemetryModelIdentity } from '../../../../repo/types.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';

export interface EventResult<T> {
  type: 'events';
  events: AsyncIterable<T>;
  modelIdentity: TelemetryModelIdentity;
  performance?: PerformanceTelemetryContext;
  finalMetadata?: Promise<EventResultMetadata>;
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
// `ExecuteResult`: the target emit/interceptor layer never produces one. It is
// combined into the source-level `Result` (see sources/traits.ts), so the
// orchestrator passes it straight to `respond` without persistence, and
// `respond` emits it verbatim.
export interface PlainResult {
  type: 'plain';
  status: number;
  headers: Headers;
  body: Uint8Array;
}

export type ExecuteResult<T> = EventResult<T> | UpstreamErrorResult | InternalErrorResult;

export const eventResult = <T>(
  events: AsyncIterable<T>,
  modelIdentity: TelemetryModelIdentity,
  performance?: PerformanceTelemetryContext,
  finalMetadata?: Promise<EventResultMetadata>,
): EventResult<T> => {
  const result: EventResult<T> = { type: 'events', events, modelIdentity };
  if (performance !== undefined) {
    result.performance = performance;
  }
  if (finalMetadata !== undefined) result.finalMetadata = finalMetadata;
  return result;
};

export const internalErrorResult = (status: number, error: InternalDebugError, performance?: PerformanceTelemetryContext): InternalErrorResult => ({
  type: 'internal-error',
  status,
  error,
  ...(performance ? { performance } : {}),
});

export const plainResult = (status: number, headers: Headers, body: Uint8Array): PlainResult => ({ type: 'plain', status, headers, body });
