import type { ProviderCandidate } from './candidates.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import { eventResult, readUpstreamError, type ExecuteResult, type ProviderStreamResult, type TelemetryModelIdentity } from '@floway-dev/provider';

// Telemetry identity for the chosen candidate plus the upstream-reported
// model key. Pricing reads off the provider so the cost lookup respects any
// provider-specific override.
export const telemetryModelIdentity = (candidate: ProviderCandidate, modelKey: string): TelemetryModelIdentity => ({
  model: candidate.binding.upstreamModel.id,
  upstream: candidate.binding.upstream,
  modelKey,
  cost: candidate.binding.provider.getPricingForModelKey(modelKey),
});

// Lifts a provider's streaming-call result into the attempt's ExecuteResult
// shape: a non-ok provider response is read into an `upstream-error` so the
// caller can relay status + body verbatim, otherwise the events stream
// flows on with the attached telemetry identity.
export const providerStreamResultToExecuteResult = async <TEvent>(
  providerResult: ProviderStreamResult<TEvent>,
  candidate: ProviderCandidate,
): Promise<ExecuteResult<ProtocolFrame<TEvent>>> => {
  if (!providerResult.ok) return await readUpstreamError(providerResult.response);
  return eventResult(
    providerResult.events as AsyncIterable<ProtocolFrame<TEvent>>,
    telemetryModelIdentity(candidate, providerResult.modelKey),
  );
};

// `ctx.headers` is the shared Headers bag every protocol crosses; the per-
// invocation `Record<string, string>` is where provider-side interceptors
// still write. Merge with invocation-set values winning so a provider
// interceptor can override a header the ctx already carried.
export const mergeInvocationHeaders = (ctxHeaders: Headers, invocationHeaders: Record<string, string>): Record<string, string> => {
  const merged: Record<string, string> = {};
  ctxHeaders.forEach((value, key) => {
    merged[key] = value;
  });
  for (const [key, value] of Object.entries(invocationHeaders)) merged[key] = value;
  return merged;
};
