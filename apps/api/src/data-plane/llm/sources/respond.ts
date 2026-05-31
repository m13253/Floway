import type { TelemetryModelIdentity, TokenUsage } from '../../../repo/types.ts';
import { recordRequestPerformanceForApiKey } from '../../shared/telemetry/performance.ts';
import { hasTokenUsage, recordTokenUsageForApiKey } from '../../shared/telemetry/usage.ts';
import type { RequestContext } from '../interceptors.ts';
import type { EventResultMetadata, ExecuteResult } from '../shared/errors/result.ts';
import type { StreamCompletion } from '../shared/stream/proxy-sse.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';

// Per-stream observation accumulated by each source's frame observer and read
// back when the response settles: did the stream fail, did it reach its
// terminal frame, and the last frame-level usage worth billing.
export class SourceStreamState {
  failed = false;
  completed = false;
  usage: TokenUsage | null = null;

  // Only a frame carrying real (non-zero) usage overwrites the running figure,
  // so an empty trailing frame can't wipe a good count.
  rememberUsage(usage: TokenUsage | null): void {
    if (usage && hasTokenUsage(usage)) this.usage = usage;
  }

  // Whether the streamed response should be recorded as failed: an upstream or
  // internal error frame set `failed`, the writer reported an error completion,
  // or the client cancelled before the terminal frame arrived.
  failedAfter(completion: StreamCompletion): boolean {
    return completion === 'error' || this.failed || (completion === 'cancel' && !this.completed);
  }
}

// The events result's metadata, resolved once: prefer the upstream's finalized
// metadata, else fall back to the identity/performance carried on the result.
export const eventResultMetadata = async <TEvent>(result: Extract<ExecuteResult<ProtocolFrame<TEvent>>, { type: 'events' }>): Promise<EventResultMetadata> =>
  await (result.finalMetadata ?? {
    modelIdentity: result.modelIdentity,
    ...(result.performance ? { performance: result.performance } : {}),
  });

export const recordSourceUsage = async (request: RequestContext, modelIdentity: TelemetryModelIdentity, usage: TokenUsage | null): Promise<void> => {
  if (usage && hasTokenUsage(usage)) await recordTokenUsageForApiKey(request.apiKeyId, modelIdentity, usage);
};

export const recordSourcePerformance = (request: RequestContext, context: EventResultMetadata['performance'], failed: boolean): void => {
  recordRequestPerformanceForApiKey(request.apiKeyId, request.scheduleBackground, context, failed, performance.now() - request.requestStartedAt);
};
