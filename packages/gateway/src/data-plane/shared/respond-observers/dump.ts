import type { Context } from 'hono';

import type { ApiKey, TokenUsage } from '../../../repo/types.ts';
import type { RespondObserver } from '../respond-observer.ts';
import type { DumpStreamEvent } from '@floway-dev/protocols/dump';

// Dimensions an upstream may report independently. Missing dimensions stay
// null on the persisted record (not measured); summing the present ones
// preserves the disjoint-counts semantic so a zero in the dump row really
// means zero tokens, not "we didn't see it".
const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const { input, input_cache_read, input_cache_write } = usage;
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null;
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0);
};

const tokenUsageOutput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  return usage.output ?? null;
};

export interface DumpAccounting {
  upstreamId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

const plainAccounting: DumpAccounting = {
  upstreamId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
};

// Translates `RespondObserver` lifecycle events into the dump record's
// accounting + event stream. The middleware reads `events` and `accounting`
// back after `next()` resolves to assemble the persisted `DumpRecord`.
export class DumpRespondObserver implements RespondObserver {
  readonly events: DumpStreamEvent[] = [];
  accounting: DumpAccounting = plainAccounting;
  constructor(private readonly startedAt: number) {}

  upstreamError(result: { status: number }): void {
    this.accounting = { ...plainAccounting, error: `upstream error ${result.status}` };
  }

  internalError(result: { error: { message: string } }): void {
    this.accounting = { ...plainAccounting, error: result.error.message };
  }

  plain(): void {
    this.accounting = plainAccounting;
  }

  frame(sse: { event?: string; data: string } | null): void {
    if (!sse) return;
    this.events.push({ event: sse.event ?? null, data: sse.data, ts: Date.now() - this.startedAt });
  }

  success(identity: { upstream: string; model: string }, usage: TokenUsage | null): void {
    this.accounting = {
      upstreamId: identity.upstream,
      model: identity.model,
      inputTokens: tokenUsageInput(usage),
      outputTokens: tokenUsageOutput(usage),
      error: null,
    };
  }

  error(reason: string): void {
    this.accounting = { ...plainAccounting, error: reason };
  }
}

// Factory exposed through the observer registry. Returns null when the
// request's api key has no retention configured, so the request never pays
// the per-event-frame iteration cost on opt-out keys. The capture middleware
// keeps the returned reference (when non-null) to read back the accumulated
// state after the data plane finishes.
export const dumpRespondObserver = (_c: Context, deps: { apiKey: ApiKey; startedAt: number }): DumpRespondObserver | null => {
  if (deps.apiKey.dumpRetentionSeconds === null) return null;
  return new DumpRespondObserver(deps.startedAt);
};
