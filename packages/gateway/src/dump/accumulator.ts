// Per-request dump pipeline. Opens the dump session (request snapshot +
// opt-in decision) and exposes the mid-flight hooks the respond layer
// calls to record outcomes and frames. When the api key has no retention
// configured, opening returns null and the data plane pays no per-request
// cost.

import type { Context } from 'hono';

import { getDumpBroker, getDumpStore } from './registry.ts';
import type {
  DumpMetadata,
  DumpStreamEvent,
  DumpUpstreamRef,
  StoredDumpRecord,
  StoredDumpResponseBody,
} from './types.ts';
import type { RequestBody } from '../data-plane/llm/shared/request-body.ts';
import { getRepo } from '../repo/index.ts';
import type { ApiKey, TokenUsage } from '../repo/types.ts';
import { ulid } from '../shared/ulid.ts';
import type { BackgroundScheduler } from '@floway-dev/platform';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

// Frozen at ctx construction so `finalize` never has to re-read a stream
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

// Two disjoint outcome slots the mid-flight hooks stamp: a success-path
// identity (set by `success()`, leaves the record with full upstream +
// model + token attribution) and an error-path message (set by
// `upstreamError` / `internalError` / `error`, leaves the record with no
// success attribution). `plain()` records neither — used by respond paths
// where the gateway forwarded an upstream response verbatim without
// resolving its own identity.
interface DumpSuccessIdentity {
  upstreamId: string;
  model: string;
  inputTokens: number | null;
  outputTokens: number | null;
}

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
  private successIdentity: DumpSuccessIdentity | null = null;
  private errorMessage: string | null = null;

  constructor(
    private readonly apiKey: ApiKey,
    private readonly requestSnapshot: RequestSnapshot,
    private readonly startedAt: number,
    private readonly backgroundScheduler: BackgroundScheduler,
  ) {}

  // --- mid-flight hooks (called from per-protocol respond layer) ---

  upstreamError(status: number): void {
    this.errorMessage = `upstream error ${status}`;
  }

  internalError(message: string): void {
    this.errorMessage = message;
  }

  plain(): void {
    this.successIdentity = null;
    this.errorMessage = null;
  }

  // Records one protocol frame. Stored as the canonical ProtocolFrame so
  // neither serialization nor parsing happens on this path; the dashboard
  // derives the SSE wire view on demand via the per-protocol
  // frame-to-SSE encoder + reducer.
  frame(frame: ProtocolFrame<unknown>): void {
    this.events.push({ frame, ts: Date.now() - this.startedAt });
  }

  success(identity: TelemetryModelIdentity, usage: TokenUsage | null): void {
    this.successIdentity = {
      upstreamId: identity.upstream,
      model: identity.model,
      inputTokens: tokenUsageInput(usage),
      outputTokens: usage?.output ?? null,
    };
  }

  error(reason: unknown): void {
    this.errorMessage = typeof reason === 'string' ? reason : oneLineError(reason);
  }

  // --- response-side: handler exit ---

  // Schedules the dump-record write at the turn's terminal point. Two input
  // shapes:
  //
  //   • `(status, headers)` — no HTTP Response object to tee. The WebSocket
  //     Responses path uses this: its "response" is the stream of frames
  //     already captured via `frame()` and the terminal status is supplied
  //     by the caller.
  //   • `(response)` — tees the response body so the client gets bytes
  //     flowing while a background reader accumulates the other half. The
  //     returned Response streams the client-side bytes; status, statusText,
  //     and headers pass through verbatim so the tee is invisible to the
  //     client. A null body falls through to the bare form.
  //
  // The background drain → record assembly → store put → broker publish is
  // scheduled through the runtime's BackgroundScheduler so observer write
  // failures cannot turn a successful upstream call into a 502.
  finalize(status: number, headers: ReadonlyArray<readonly [string, string]>): void;
  finalize(response: Response): Response;
  finalize(...args: [number, ReadonlyArray<readonly [string, string]>] | [Response]): void | Response {
    if (args.length === 2) {
      const [status, headers] = args;
      this.backgroundScheduler(this.write({
        status,
        headers: headers.map(([k, v]) => [k, v]),
        isStream: this.events.length > 0,
        bytes: new Uint8Array(),
        streamError: null,
      }));
      return;
    }

    const [response] = args;
    const responseStatus = response.status;
    const responseHeaders = headerPairs(response.headers);

    if (response.body === null) {
      this.finalize(responseStatus, responseHeaders);
      return response;
    }

    const isStream = (response.headers.get('content-type') ?? '').startsWith('text/event-stream');
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
      upstream: await resolveUpstreamRef(this.successIdentity?.upstreamId ?? null),
      model: this.successIdentity?.model ?? null,
      inputTokens: this.successIdentity?.inputTokens ?? null,
      outputTokens: this.successIdentity?.outputTokens ?? null,
      requestBytes: this.requestSnapshot.body.byteLength,
      responseBytes: response.bytes.byteLength,
      durationMs: completedAt - this.startedAt,
      // Precedence: explicit upstream-side errors raised by the respond path
      // come first; otherwise a request-body read failure (operator-side
      // payload didn't arrive intact) outranks a response-body read failure.
      error: this.errorMessage ?? this.requestSnapshot.streamError ?? response.streamError,
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
// per-request dump work. `method` is passed explicitly rather than read
// off the request so the WebSocket Responses path can record each turn
// as `WS /v1/responses` rather than the upgrade's `GET`.
export const openDumpAccumulator = (
  c: Context,
  method: string,
  apiKey: ApiKey,
  requestBody: RequestBody,
  backgroundScheduler: BackgroundScheduler,
): DumpAccumulator | null => {
  if (apiKey.dumpRetentionSeconds === null) return null;
  const requestSnapshot: RequestSnapshot = {
    method,
    path: c.req.path,
    headers: headerPairs(c.req.raw.headers),
    body: requestBody.bytes,
    streamError: requestBody.streamError,
  };
  return new DumpAccumulator(apiKey, requestSnapshot, Date.now(), backgroundScheduler);
};
