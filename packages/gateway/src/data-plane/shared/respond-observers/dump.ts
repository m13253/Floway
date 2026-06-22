import { getDumpBroker, getDumpStore } from '../../../dump/registry.ts';
import { getRepo } from '../../../repo/index.ts';
import type { ApiKey, TokenUsage } from '../../../repo/types.ts';
import { encodeBodyForWire } from '../../../shared/dump-wire.ts';
import { ulid } from '../../../shared/ulid.ts';
import type { GatewayCtx } from '../../llm/shared/gateway-ctx.ts';
import type { RespondCapture, RespondObserver } from '../respond-observer.ts';
import type {
  DumpMetadata,
  DumpRecord,
  DumpRequest,
  DumpResponse,
  DumpResponseBody,
  DumpStreamEvent,
  DumpUpstreamRef,
} from '@floway-dev/protocols/dump';

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

const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

interface DumpAccounting {
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

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.provider };
};

// Translates `RespondObserver` lifecycle events into the dump record's
// accounting + event stream, then persists the record through the configured
// store and broker once the request settles. The observer keeps its own
// per-request state (events log, accounting snapshot, startedAt), so the
// generic middleware that drives observers doesn't need to know dump
// specifics — it just hands every observer the same `RespondCapture` and
// lets the dump observer assemble + write its own record.
export class DumpRespondObserver implements RespondObserver {
  private readonly events: DumpStreamEvent[] = [];
  private accounting: DumpAccounting = plainAccounting;
  constructor(private readonly apiKey: ApiKey, private readonly startedAt: number) {}

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

  async finalize(_ctx: GatewayCtx, capture: RespondCapture): Promise<void> {
    // ULID-from-completedAt keeps id-time and `created_at` agreeing on a row:
    // ordering off-cursor (decoded ULID timestamp == row creation) matches
    // ordering on-cursor (the ORDER BY (created_at, id) tie-breaker).
    const recordId = ulid(capture.completedAt);

    // Prefer the observer's frame log over the outbound body so dumps reflect
    // the gateway's own frame sequence regardless of the negotiated wire
    // shape. Non-LLM endpoints (passthrough) produce no frames and fall back
    // to the captured bytes; the `isStream` discriminator off the outbound
    // content-type still decides bytes-vs-events on that fallback path.
    const responseBody: DumpResponseBody = this.events.length > 0
      ? { type: 'stream', events: this.events }
      : capture.response.bytes.byteLength > 0 || capture.response.streamError !== null
        ? capture.response.isStream
          ? { type: 'stream', events: [] }
          : { type: 'bytes', body: encodeBodyForWire(capture.response.bytes, capture.response.contentType) }
        : { type: 'none' };

    const meta: DumpMetadata = {
      id: recordId,
      startedAt: capture.startedAt,
      completedAt: capture.completedAt,
      method: capture.request.method,
      path: capture.request.path,
      status: capture.response.status,
      upstream: await resolveUpstreamRef(this.accounting.upstreamId),
      model: this.accounting.model,
      inputTokens: this.accounting.inputTokens,
      outputTokens: this.accounting.outputTokens,
      requestBytes: capture.request.body.byteLength,
      responseBytes: capture.response.bytes.byteLength,
      durationMs: capture.completedAt - capture.startedAt,
      // Precedence: explicit upstream-side errors raised by the respond path
      // come first; otherwise a request-body read failure (operator-side
      // payload didn't arrive intact) outranks a response-body read failure.
      error: this.accounting.error ?? capture.request.streamError ?? capture.response.streamError,
    };

    const request: DumpRequest = {
      method: capture.request.method,
      path: capture.request.path,
      headers: capture.request.headers.map(([k, v]) => [k, v]),
      body: encodeBodyForWire(capture.request.body, capture.request.contentType),
    };

    const responseHead: DumpResponse = {
      status: capture.response.status,
      headers: capture.response.headers.map(([k, v]) => [k, v]),
    };

    const record: DumpRecord = {
      meta,
      request,
      response: { ...responseHead, ...responseBody },
    };

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      await getDumpStore().put(this.apiKey.id, record);
      await getDumpBroker().publish(this.apiKey.id, meta);
    } catch (err) {
      console.error(`[dump] finalize failed for key=${this.apiKey.id} record=${recordId}`, oneLineError(err));
    }
  }
}

// Factory exposed through the observer registry. Returns null when the
// request's api key has no retention configured, so the request never pays
// the per-event-frame iteration cost or the body-tee cost on opt-out keys.
export const dumpRespondObserver = (deps: { apiKey: ApiKey; startedAt: number }): DumpRespondObserver | null => {
  if (deps.apiKey.dumpRetentionSeconds === null) return null;
  return new DumpRespondObserver(deps.apiKey, deps.startedAt);
};
