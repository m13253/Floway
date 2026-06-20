import type { Context, Next } from 'hono';

import { getRepo } from '../../repo/index.ts';
import type { ApiKey, TokenUsage } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getDumpBroker, getDumpStore } from '../../runtime/dump.ts';
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

// What the LLM respond paths (and passthrough-serve) hand back to the capture
// middleware: the upstream they ended up calling, the model they billed, the
// usage they decided to record. Stamped by helpers below at the same points
// `recordUsage` / `recordPerformance` fire — keeping the wiring colocated
// means a future telemetry-only path inherits dump accounting automatically.
export interface DumpAccounting {
  upstreamId: string | null;
  model: string | null;
  inputTokens: number | null;
  outputTokens: number | null;
  error: string | null;
}

export const plainDumpAccounting: DumpAccounting = {
  upstreamId: null,
  model: null,
  inputTokens: null,
  outputTokens: null,
  error: null,
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
    outputTokens: usage?.output ?? null,
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

const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const input = usage.input ?? 0;
  const cacheRead = usage.input_cache_read ?? 0;
  const cacheWrite = usage.input_cache_write ?? 0;
  const total = input + cacheRead + cacheWrite;
  return total === 0 ? null : total;
};

const oneLineError = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

// Hono middleware factory. Mounted on the data plane in `mountDataPlane` so
// every billable request flows through it. The middleware short-circuits when
// the request's api key has no retention configured (the common case for keys
// the operator hasn't opted in) — no body cloning, no res-body teeing,
// effectively zero overhead.
export const captureRequestDump = () => async (c: Context, next: Next): Promise<void> => {
  const apiKey = c.get('apiKey') as ApiKey | undefined;
  if (apiKey?.dumpRetentionSeconds == null) {
    await next();
    return;
  }

  const startedAt = Date.now();
  const requestClone = c.req.raw.clone();

  await next();

  const completedAt = Date.now();
  const upstream = c.res;
  const accounting = (c.get('dumpAccounting') as DumpAccounting | undefined) ?? plainDumpAccounting;

  // Tee the response body so the client gets one half and the capture
  // consumer reads the other. Replacing c.res with a fresh Response wired to
  // the client-side stream is the documented Hono pattern for body rewriting.
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

  // Run finalize as a background task so a slow capture cannot delay the
  // client response. backgroundSchedulerFromContext routes rejections through
  // the runtime's own error sink (CF waitUntil swallows + we log; Node logs
  // explicitly) — we let them propagate rather than wrapping in try/catch.
  const finalize = async (): Promise<void> => {
    const { bytes: requestBytes, streamError: requestStreamError } = await readAllBytes(requestClone.body);
    const captured = teedForCapture ? await collectResponse(teedForCapture, isStream, startedAt) : { kind: 'none' as const, byteLength: 0 };
    const captureError = captured.kind !== 'none' ? captured.streamError : null;

    const recordId = ulid(startedAt);
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
    const responseBody: DumpResponseBody = captured.kind === 'events'
      ? { type: 'stream', events: captured.events }
      : captured.kind === 'bytes'
        ? { type: 'bytes', body: encodeBodyForWire(captured.bytes, responseContentType) }
        : { type: 'none' };

    const record: DumpRecord = {
      meta,
      request,
      response: { ...responseHead, ...responseBody },
    };

    // Strict ordering: the row must commit before we publish, so a subscriber
    // that races to fetch detail on the meta frame finds the row.
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

const readAllBytes = async (body: ReadableStream<Uint8Array> | null): Promise<{ bytes: Uint8Array; streamError: string | null }> => {
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
    // Partial body is still useful — return what we got, then surface the
    // error through `streamError` so meta.error can explain why the bytes
    // look short. Mirrors `collectResponse`'s response-side contract.
    streamError = `request body read failed: ${oneLineError(err)}`;
  }
  return { bytes: concatChunks(chunks), streamError };
};

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
      streamError = `response body read failed: ${oneLineError(err)}`;
    }
    const bytes = concatChunks(chunks);
    return { kind: 'bytes', bytes, byteLength: bytes.byteLength, streamError };
  }

  const events: DumpStreamEvent[] = [];
  let byteLength = 0;
  let streamError: string | null = null;
  // Count bytes off the tee separately from SSE parsing because parseSSEStream
  // consumes the same stream — running the byte counter through a TransformStream
  // upstream of the parser keeps the wire-byte total honest.
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
      // Counting failure is non-fatal — the parser path will report the real
      // error if the stream truly broke. We swallow here to avoid double-reporting.
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
    streamError = `SSE parse failed: ${oneLineError(err)}`;
  }
  await countingPromise;
  return { kind: 'events', events, byteLength, streamError };
};

const TEXT_LIKE_PREFIXES = ['text/', 'application/json', 'application/javascript', 'application/xml', 'application/x-www-form-urlencoded'];

const looksTextual = (contentType: string): boolean => {
  const ct = contentType.toLowerCase();
  return TEXT_LIKE_PREFIXES.some(prefix => ct.startsWith(prefix));
};

const encodeBodyForWire = (bytes: Uint8Array, contentType: string): string => {
  if (looksTextual(contentType)) {
    try {
      return new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    } catch {
      // Fall through to base64 — a content-type lied about being text.
    }
  }
  return bytesToBase64(bytes);
};

const bytesToBase64 = (bytes: Uint8Array): string => {
  let binary = '';
  for (let i = 0; i < bytes.byteLength; i++) binary += String.fromCharCode(bytes[i]!);
  return btoa(binary);
};

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return { id, name: id, kind: 'unknown' };
  return { id: upstream.id, name: upstream.name, kind: upstream.provider };
};
