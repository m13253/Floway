import type { Context, Next } from 'hono';

import { getDumpBroker, getDumpStore } from '../../dump/registry.ts';
import { getRepo } from '../../repo/index.ts';
import type { ApiKey, TokenUsage } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { encodeBodyForWire } from '../../shared/dump-wire.ts';
import { ulid } from '../../shared/ulid.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import {
  type DumpMetadata,
  type DumpRecord,
  type DumpRequest,
  type DumpResponse,
  type DumpResponseBody,
  type DumpStreamEvent,
  type DumpUpstreamRef,
} from '@floway-dev/protocols/dump';
import type { TelemetryModelIdentity } from '@floway-dev/provider';

export interface DumpAccounting {
  upstreamId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

// Default shape for routes that complete without identifying an upstream
// (plain echoes, non-LLM routes). Module-private so the `'dumpAccounting'`
// key name stays inside this file — callers go through the setters.
const plainDumpAccounting: DumpAccounting = {
  upstreamId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
};

export const setPlainDumpAccounting = (c: Context): void => {
  c.set('dumpAccounting', plainDumpAccounting);
};

export const setDumpAccountingFromIdentity = (
  c: Context,
  identity: TelemetryModelIdentity,
  usage: TokenUsage | null,
): void => {
  c.set('dumpAccounting', {
    upstreamId: identity.upstream,
    model: identity.model,
    inputTokens: tokenUsageInput(usage),
    outputTokens: tokenUsageOutput(usage),
    error: null,
  } satisfies DumpAccounting);
};

export const errorDumpAccounting = (c: Context, error: unknown): void => {
  c.set('dumpAccounting', {
    upstreamId: null,
    model: null,
    inputTokens: null,
    outputTokens: null,
    error: oneLineError(error),
  } satisfies DumpAccounting);
};

// Initialised by the middleware when retention is on; left undefined
// otherwise so `appendDumpEvent` short-circuits at zero cost on opt-out keys.
interface DumpEventsCapture {
  readonly events: DumpStreamEvent[];
  readonly startedAt: number;
}

const DUMP_EVENTS_KEY = 'dumpEventsCapture';

const initDumpEventsCapture = (c: Context, startedAt: number): void => {
  c.set(DUMP_EVENTS_KEY, { events: [], startedAt });
};

const getDumpEventsCapture = (c: Context): DumpEventsCapture | undefined => {
  return c.get(DUMP_EVENTS_KEY) as DumpEventsCapture | undefined;
};

export const appendDumpEvent = (c: Context, event: string | null, data: string): void => {
  const capture = getDumpEventsCapture(c);
  if (!capture) return;
  capture.events.push({ event, data, ts: Date.now() - capture.startedAt });
};

// Missing dimensions stay null (not measured); sum only the present ones.
// Collapsing to 0 would conflate "no data" with "0 tokens".
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

export const captureRequestDump = () => async (c: Context, next: Next): Promise<void> => {
  const apiKey = c.get('apiKey') as ApiKey | undefined;
  if (!apiKey) {
    throw new Error('captureRequestDump: c.get("apiKey") was not set; auth middleware order is wrong');
  }
  if (apiKey.dumpRetentionSeconds === null) {
    await next();
    return;
  }

  const startedAt = Date.now();
  const requestClone = c.req.raw.clone();
  initDumpEventsCapture(c, startedAt);

  await next();

  const completedAt = Date.now();
  const upstream = c.res;

  let teedForClient: ReadableStream<Uint8Array> | null = null;
  let teedForCapture: ReadableStream<Uint8Array> | null = null;
  if (upstream.body) {
    [teedForClient, teedForCapture] = upstream.body.tee();
    c.res = new Response(teedForClient, {
      status: upstream.status,
      headers: upstream.headers,
    });
  }

  const responseStatus = upstream.status;
  const responseHeaders = headersToPairs(upstream.headers);
  const responseContentType = upstream.headers.get('content-type') ?? '';
  const isStream = responseContentType.toLowerCase().includes('text/event-stream');
  const requestHeaders = headersToPairs(c.req.raw.headers);
  const requestContentType = c.req.raw.headers.get('content-type') ?? '';

  // Schedule as a background task so capture cannot delay the client response.
  const finalize = async (): Promise<void> => {
    const { bytes: requestBytes, streamError: requestStreamError } = await drainBody(requestClone.body, 'request');
    const captured = teedForCapture ? await collectResponse(teedForCapture, isStream, startedAt) : { kind: 'none' as const, byteLength: 0 };
    const captureError = captured.kind !== 'none' ? captured.streamError : null;

    // Read accounting after the response drains: streaming respond paths
    // stamp `dumpAccounting` from the streamSSE callback's finally, which
    // only completes once `collectResponse` resolves. Routes that never
    // reach a respond layer fall back to the plain shape.
    const accounting = (c.get('dumpAccounting') as DumpAccounting | undefined) ?? plainDumpAccounting;

    // ULID-from-completedAt keeps id-time and `created_at` agreeing on a row:
    // ordering off-cursor (decoded ULID timestamp == row creation) matches
    // ordering on-cursor (the ORDER BY (created_at, id) tie-breaker).
    const recordId = ulid(completedAt);
    const meta: DumpMetadata = {
      id: recordId,
      startedAt,
      completedAt,
      method: c.req.method,
      path: pathWithQuery(c.req.raw.url),
      status: responseStatus,
      upstream: await resolveUpstreamRef(accounting.upstreamId),
      model: accounting.model,
      inputTokens: accounting.inputTokens,
      outputTokens: accounting.outputTokens,
      requestBytes: requestBytes.byteLength,
      responseBytes: captured.byteLength,
      durationMs: completedAt - startedAt,
      error: accounting.error ?? requestStreamError ?? captureError,
    };

    const request: DumpRequest = {
      method: c.req.method,
      path: meta.path,
      headers: requestHeaders,
      body: encodeBodyForWire(requestBytes, requestContentType),
    };

    const responseHead: DumpResponse = {
      status: responseStatus,
      headers: responseHeaders,
    };

    // Prefer the internal-events tap over the outbound body so dumps reflect
    // the gateway's own frame sequence regardless of the negotiated wire shape.
    const tappedEvents = getDumpEventsCapture(c)?.events ?? [];
    const responseBody: DumpResponseBody = tappedEvents.length > 0
      ? { type: 'stream', events: tappedEvents }
      : captured.kind === 'events'
        ? { type: 'stream', events: captured.events }
        : captured.kind === 'bytes'
          ? { type: 'bytes', body: encodeBodyForWire(captured.bytes, responseContentType) }
          : { type: 'none' };

    const record: DumpRecord = {
      meta,
      request,
      response: { ...responseHead, ...responseBody },
    };

    // Commit the row before publishing so subscribers fetching detail off the meta frame find it.
    await getDumpStore().put(apiKey.id, record);
    await getDumpBroker().publish(apiKey.id, meta);
  };

  backgroundSchedulerFromContext(c)(finalize());
};

const headersToPairs = (headers: Headers): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  for (const [name, value] of headers.entries()) out.push([name, value]);
  return out;
};

const pathWithQuery = (rawUrl: string): string => {
  const url = new URL(rawUrl);
  return `${url.pathname}${url.search}`;
};

// Returns the best-effort prefix on a mid-read failure plus a labelled
// streamError so request and response surfaces feed `meta.error` symmetrically.
const drainBody = async (
  body: ReadableStream<Uint8Array> | null,
  label: 'request' | 'response',
): Promise<{ bytes: Uint8Array; streamError: string | null }> => {
  if (!body) return { bytes: new Uint8Array(0), streamError: null };
  const chunks: Uint8Array[] = [];
  const reader = body.getReader();
  let streamError: string | null = null;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) chunks.push(value);
    }
  } catch (err) {
    streamError = streamErrorMessage(`${label} body read`, err);
  }
  return { bytes: concatChunks(chunks), streamError };
};

const streamErrorMessage = (label: string, err: unknown): string =>
  `${label} failed: ${oneLineError(err)}`;

const concatChunks = (chunks: readonly Uint8Array[]): Uint8Array => {
  let total = 0;
  for (const chunk of chunks) total += chunk.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
};

type CapturedResponse =
  | { kind: 'bytes'; bytes: Uint8Array; byteLength: number; streamError: string | null }
  | { kind: 'events'; events: DumpStreamEvent[]; byteLength: number; streamError: string | null }
  | { kind: 'none'; byteLength: 0 };

const collectResponse = async (
  body: ReadableStream<Uint8Array>,
  isStream: boolean,
  startedAt: number,
): Promise<CapturedResponse> => {
  if (!isStream) {
    const { bytes, streamError } = await drainBody(body, 'response');
    return { kind: 'bytes', bytes, byteLength: bytes.byteLength, streamError };
  }

  const events: DumpStreamEvent[] = [];
  let byteLength = 0;
  let streamError: string | null = null;
  // parseSSEStream consumes the stream, so count bytes off a separate tee
  // branch to keep the wire-byte total honest.
  const [forCount, forParse] = body.tee();
  const countingPromise = (async () => {
    const reader = forCount.getReader();
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        if (value) byteLength += value.byteLength;
      }
    } catch {
      // Parser branch reports the real error; counting failure is non-fatal.
    }
  })();
  try {
    for await (const frame of parseSSEStream(forParse)) {
      events.push({
        event: frame.event ?? null,
        data: frame.data,
        ts: Date.now() - startedAt,
      });
    }
  } catch (err) {
    streamError = streamErrorMessage('response SSE parse', err);
  }
  await countingPromise;
  return { kind: 'events', events, byteLength, streamError };
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.provider };
};
