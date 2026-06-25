import type { ProviderCandidate } from './candidates.ts';
import type { GatewayCtx } from './gateway-ctx.ts';
import { recordUpstreamHttpFailure, upstreamPerformanceContext, withUpstreamTelemetry } from './upstream-telemetry.ts';
import { requireRecordedDurationMs, type UpstreamLatencyRecorder } from '../../shared/telemetry/performance.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamApiError, type ExecuteResult, type ProviderStreamResult, type TelemetryModelIdentity, type UpstreamCallOptions } from '@floway-dev/provider';

// Telemetry identity for the chosen candidate plus the upstream-reported
// model key. Pricing reads off the provider so the cost lookup respects any
// provider-specific override.
//
// `model` is the upstream-facing bare id (`candidate.binding.upstreamModel.id`,
// e.g. `gpt-4o`) regardless of which surface form the client called
// (`or/gpt-4o` or `gpt-4o`). Usage and performance aggregates therefore key on
// the canonical upstream id, and a dashboard slice over `model` rolls up both
// surfaces of the same upstream model under one row.
export const telemetryModelIdentity = (candidate: ProviderCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.binding.upstreamModel.id,
  upstream: candidate.binding.upstream,
  modelKey,
  cost: candidate.binding.provider.getPricingForModelKey(modelKey),
});

// Per-call UpstreamCallOptions for the chosen candidate; see
// UpstreamCallOptions in `@floway-dev/provider` for the contract on each
// field, especially header ownership.
export const buildUpstreamCallOptions = (
  candidate: ProviderCandidate,
  ctx: GatewayCtx,
  recordUpstreamLatency: UpstreamCallOptions['recordUpstreamLatency'],
  headers: Headers,
): UpstreamCallOptions => ({
  fetcher: candidate.fetcher,
  recordUpstreamLatency,
  waitUntil: ctx.backgroundScheduler,
  headers,
});

// Lifts a provider's streaming-call result into the attempt's ExecuteResult
// shape, attaching the performance telemetry context every layer above reads:
// a non-ok provider response is read into an `api-error` (source 'upstream')
// carrying the context (and records its `upstream_success` failure),
// otherwise the events stream is wrapped with upstream telemetry and flows on
// with both the telemetry identity and the context.
//
// Latency contract by branch:
//   - ok=true: a real upstream call happened; durationMs MUST be present,
//     so we assert it before threading into the success telemetry path.
//   - ok=false: an upstream call MAY have happened (non-2xx from an actual
//     upstream) or MAY NOT (a request-side 400 the provider short-circuited
//     at the gateway before any fetch). The duration is whatever the
//     recorder happens to know — passed through to recordUpstreamHttpFailure,
//     which records the latency on the failure metric when present and skips
//     it when null.
export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ProviderCandidate,
  ctx: GatewayCtx,
  recorder: UpstreamLatencyRecorder,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  const context = upstreamPerformanceContext(ctx, candidate, providerResult.modelKey);
  if (!providerResult.ok) {
    recordUpstreamHttpFailure(ctx, context, recorder.durationMs());
    return { ...(await readUpstreamApiError(providerResult.response, candidate.binding.upstream)), performance: context };
  }
  return eventResult(
    withUpstreamTelemetry(providerResult.events, ctx, context, candidate.targetApi, requireRecordedDurationMs(recorder, 'upstream success')),
    telemetryModelIdentity(candidate, providerResult.modelKey),
    { performance: context, headers: providerResult.headers },
  );
};
