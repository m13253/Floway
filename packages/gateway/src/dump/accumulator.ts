// First-class per-request dump pipeline. Opens the per-request session
// (request snapshot + opt-in decision) and exposes the mid-flight hooks
// the respond layer calls to record outcomes and frames. When the api
// key has no retention configured, opening returns null and the data
// plane pays no per-request cost.

import type { Context } from 'hono';

import { getDumpBroker, getDumpStore } from './registry.ts';
import type {
  DumpMetadata,
  DumpStreamEvent,
  DumpUpstreamRef,
  StoredDumpRecord,
  StoredDumpResponseBody,
} from './types.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { InternalErrorResult, TelemetryModelIdentity } from '@floway-dev/provider';

// Inbound body bytes the handler reads once and forwards into the
// accumulator (so the handler's payload parser AND the dump see the same
// bytes without a second read). `streamError` surfaces a client mid-upload
// abort as a non-null message; observers see it on `meta.error`.
export interface RequestBody {
  readonly bytes: Uint8Array;
  readonly streamError: string | null;
}

// Shared sentinel for the WebSocket upgrade path, which carries no body.
export const EMPTY_REQUEST_BODY: RequestBody = Object.freeze({ bytes: new Uint8Array(), streamError: null });

// Reads the inbound body in full into a Uint8Array. Stays here so dump
// bytes are sourced from one place; the handler also parses its payload
// off `result.bytes` so the wire body is consumed exactly once. A body
// read failure (client aborted upload) surfaces as a non-null
// `streamError` instead of throwing — the dump captures the partial
// payload + the cause, the handler still sees a parse error of its own.
export const readRequestBody = async (c: Context): Promise<RequestBody> => {
  if (c.req.raw.body === null) return { bytes: new Uint8Array(), streamError: null };
  try {
    return { bytes: new Uint8Array(await c.req.raw.arrayBuffer()), streamError: null };
  } catch (err) {
    return { bytes: new Uint8Array(), streamError: oneLineError(err) };
  }
};

// Frozen at ctx construction so `close()` never has to re-read a stream
// the handler already consumed.
interface RequestSnapshot {
  readonly method: string;
  readonly path: string;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly body: Uint8Array;
  readonly streamError: string | null;
}

interface ResponseSnapshot {
  readonly status: number;
  readonly headers: ReadonlyArray<readonly [string, string]>;
  readonly isStream: boolean;
  readonly bytes: Uint8Array;
  readonly streamError: string | null;
}

// Accounting the respond layer fills in via the lifecycle hooks below; one
// of {upstreamError, internalError, plain, success, error} fires per
// request and is the source of truth for the dump row's tokens / model /
// upstream / error columns.
interface DumpAccounting {
  upstreamId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

const plainAccounting: DumpAccounting = Object.freeze({
  upstreamId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
});

// Anthropic-style disjoint per-dimension counts: input excludes cache reads
// and cache writes; sum the present ones onto the dump's single inputTokens
// column. Missing dimensions stay null (not measured) instead of zero so a
// recorded zero genuinely means "upstream said zero".
const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const { input, input_cache_read, input_cache_write } = usage;
  if (input === undefined && input_cache_read === undefined && input_cache_write === undefined) return null;
  return (input ?? 0) + (input_cache_read ?? 0) + (input_cache_write ?? 0);
};

const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => { pairs.push([name, value]); });
  return pairs;
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.provider };
};

export class DumpAccumulator {
  private readonly events: DumpStreamEvent[] = [];
  private accounting: DumpAccounting = plainAccounting;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
  ) {}

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  upstreamError(status: number): void {
    this.accounting = { ...plainAccounting, error: `upstream error ${status}` };
  }

  internalError(result: InternalErrorResult): void {
    this.accounting = { ...plainAccounting, error: result.error.message };
  }

  plain(): void {
    this.accounting = plainAccounting;
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame —
  // the dashboard derives the SSE wire view on demand via the per-protocol
  // `XProtocolFrameToSSEFrame` and folds via the shared
  // `collectXProtocolEventsToResult`, so neither serialization nor parsing
  // happens on this path.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events.push({ frame, ts: Date.now() - this.startedAt });
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.accounting = {
      upstreamId: identity.upstream,
      model: identity.model,
      inputTokens: tokenUsageInput(usage),
      outputTokens: usage?.output ?? null,
      error: null,
    };
  }

  error(reason: unknown): void {
    this.accounting = { ...plainAccounting, error: typeof reason === 'string' ? reason : oneLineError(reason) };
  }

  // --- response-side: handler exit ---

  // Tees the response body so the client gets bytes flowing while a
  // background reader accumulates the other half. The returned Response
  // streams the client-side bytes; status, statusText, and headers pass
  // through verbatim so the tee is invisible to the client. Background
  // work (drain → record assembly → store put → broker publish) is
  // scheduled through the runtime's BackgroundScheduler so observer write
  // failures cannot turn a successful upstream call into a 502.
  close(response: Response): Response {
    const responseStatus = response.status;
    const responseHeaders = headerPairs(response.headers);
    const isStream = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');

    if (response.body === null) {
      this.backgroundScheduler(this.write({
        status: responseStatus, headers: responseHeaders, isStream,
        bytes: new Uint8Array(), streamError: null,
      }));
      return response;
    }

    const [forClient, forCapture] = response.body.tee();
    this.backgroundScheduler((async () => {
      const reader = forCapture.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      let streamError: string | null = null;
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          chunks.push(value);
          total += value.byteLength;
        }
      } catch (err) {
        streamError = oneLineError(err);
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
      await this.write({ status: responseStatus, headers: responseHeaders, isStream, bytes, streamError });
    })());

    return new Response(forClient, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers,
    });
  }

  // --- private: persist ---

  private async write(response: ResponseSnapshot): Promise<void> {
    // ULID-from-completedAt keeps id-time and `created_at` agreeing on a row:
    // ordering off-cursor (decoded ULID timestamp == row creation) matches
    // ordering on-cursor (the ORDER BY (created_at, id) tie-breaker).
    const completedAt = Date.now();
    const recordId = ulid(completedAt);

    // Prefer the accumulator's frame log so dumps reflect the gateway's
    // frame sequence regardless of negotiated wire shape; passthrough
    // endpoints with no frames fall back to captured bytes.
    const responseBody: StoredDumpResponseBody = this.events.length > 0
      ? { type: 'stream', events: this.events }
      : response.bytes.byteLength > 0 || response.streamError !== null
        ? response.isStream
          ? { type: 'stream', events: [] }
          : { type: 'bytes', body: response.bytes }
        : { type: 'none' };

    const meta: DumpMetadata = {
      id: recordId,
      startedAt: this.startedAt,
      completedAt,
      method: this.requestSnapshot.method,
      path: this.requestSnapshot.path,
      status: response.status,
      upstream: await resolveUpstreamRef(this.accounting.upstreamId),
      model: this.accounting.model,
      inputTokens: this.accounting.inputTokens,
      outputTokens: this.accounting.outputTokens,
      requestBytes: this.requestSnapshot.body.byteLength,
      responseBytes: response.bytes.byteLength,
      durationMs: completedAt - this.startedAt,
      // Precedence: explicit upstream-side errors raised by the respond path
      // come first; otherwise a request-body read failure (operator-side
      // payload didn't arrive intact) outranks a response-body read failure.
      error: this.accounting.error ?? this.requestSnapshot.streamError ?? response.streamError,
    };

    const record: StoredDumpRecord = {
      meta,
      request: {
        method: this.requestSnapshot.method,
        path: this.requestSnapshot.path,
        headers: this.requestSnapshot.headers.map(([k, v]) => [k, v]),
        body: this.requestSnapshot.body,
      },
      response: {
        status: response.status,
        headers: response.headers.map(([k, v]) => [k, v]),
        body: responseBody,
      },
    };

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    try {
      await getDumpStore().put(this.apiKey.id, record);
      await getDumpBroker().publish(this.apiKey.id, meta);
    } catch (err) {
      console.error(`[dump] write failed for key=${this.apiKey.id} record=${recordId}`, oneLineError(err));
    }
  }
}

// Returns null when the api key opts out of dumps; callers then skip all
// per-request dump work.
export const openDumpAccumulator = (
  c: Context,
  apiKey: ApiKey,
  requestBody: RequestBody,
  backgroundScheduler: BackgroundScheduler,
): DumpAccumulator | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const requestSnapshot: RequestSnapshot = {
    method: c.req.method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    body: requestBody.bytes,
    streamError: requestBody.streamError,
  };
  return new DumpAccumulator(apiKey, requestSnapshot, Date.now(), backgroundScheduler);
};
