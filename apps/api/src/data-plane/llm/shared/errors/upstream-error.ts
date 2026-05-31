import type { UpstreamErrorResult } from './result.ts';
import { ProviderModelsUnavailableError } from '../../../providers/models-store.ts';
import type { PerformanceTelemetryContext } from '../../../shared/telemetry/performance.ts';

export const thrownUpstreamErrorResult = (error: unknown, performance?: PerformanceTelemetryContext): UpstreamErrorResult | null => {
  if (!(error instanceof ProviderModelsUnavailableError) || !error.httpResponse) return null;

  const { status, headers, body } = error.httpResponse;
  return {
    type: 'upstream-error',
    status,
    headers: new Headers(headers),
    body: new TextEncoder().encode(body),
    ...(performance ? { performance } : {}),
  };
};

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
