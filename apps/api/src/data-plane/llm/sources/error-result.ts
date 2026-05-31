import type { PerformanceApiName } from '../../../repo/types.ts';
import type { NonLlmServeApiName } from '../../shared/api-names.ts';
import { toInternalDebugError } from '../shared/errors/internal-debug-error.ts';
import { internalErrorResult, type ExecuteResult, type UpstreamErrorResult } from '../shared/errors/result.ts';
import { thrownUpstreamErrorResult } from '../shared/errors/upstream-error.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

type PerformanceLlmSourceApi = Exclude<PerformanceApiName, NonLlmServeApiName>;

export const jsonUpstreamErrorResult = (status: number, body: unknown): UpstreamErrorResult => ({
  type: 'upstream-error',
  status,
  headers: new Headers({ 'content-type': 'application/json' }),
  body: new TextEncoder().encode(JSON.stringify(body)),
});

export const sourceErrorResult = <TEvent>(
  error: unknown,
  options: {
    sourceApi: PerformanceLlmSourceApi;
    internalStatus: number;
  },
): ExecuteResult<ProtocolFrame<TEvent>> => {
  const upstreamError = thrownUpstreamErrorResult(error);
  if (upstreamError) return upstreamError;

  return internalErrorResult(options.internalStatus, toInternalDebugError(error, options.sourceApi));
};
