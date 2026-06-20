import type { Context, Next } from 'hono';

import { getRepo } from '../../repo/index.ts';
import type { ApiKey, TokenUsage } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getDumpBroker, getDumpStore } from '../../runtime/dump.ts';
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

const tokenUsageInput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  const input = usage.input ?? 0;
  const cacheRead = usage.input_cache_read ?? 0;
  const cacheWrite = usage.input_cache_write ?? 0;
  const total = input + cacheRead + cacheWrite;
  return total === 0 ? null : total;
};

// `TokenUsage` carries `output` as an optional dimension; a missing field
// means "the upstream did not report output tokens for this request". Map
// that to null on the dump row rather than dropping it through `?? 0`,
// which would conflate "0 tokens" with "not measured".
const tokenUsageOutput = (usage: TokenUsage | null): number | null => {
  if (!usage) return null;
  return usage.output ?? null;
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
  if (!apiKey) {
    throw new Error('captureRequestDump: c.get("apiKey") was not set; auth middleware order is wrong');
  }
  if (apiKey.dumpRetentionSeconds === null) {
    await next();
    return;
  }

  const startedAt = Date.now();
  const requestClone = c.req.raw.clone();

  await next();

  const completedAt = Date.now();
  const upstream = c.res;
  // Default to the plain "no upstream identified" shape when a respond path
  // didn't stamp accounting. The data plane mounts capture-dump across every
  // billable surface plus support routes (/models, /embeddings list, the
  // Codex stub endpoints, the responses WS upgrade) — many of those never
  // reach a respond layer and have no model/upstream to attribute. The dump
  // viewer still wants to see them, just with null model/upstream.
  const accounting = (c.get('dumpAccounting') as DumpAccounting | undefined) ?? plainDumpAccounting;

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
    const { bytes: requestBytes, streamError: requestStreamError } = await drainBody(requestClone.body, 'request');
    const captured = teedForCapture ? await collectResponse(teedForCapture, isStream, startedAt) : { kind: 'none' as const, byteLength: 0 };
    const captureError = captured.kind !== 'none' ? captured.streamError : null;

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
      // Precedence: explicit upstream-side errors raised by the respond path
      // come first; otherwise a request-body read failure (operator-side
      // payload didn't arrive intact) outranks a response-body read failure.
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

// Drain a ReadableStream<Uint8Array> to a single Uint8Array. Returns the
// best-effort prefix on a mid-read failure plus a labelled streamError; both
// the request side and the bytes branch of the response side share this so
// `meta.error` describes a short body symmetrically.
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
    streamError = `${label} body read failed: ${oneLineError(err)}`;
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
    const { bytes, streamError } = await drainBody(body, 'response');
    return { kind: 'bytes', bytes, byteLength: bytes.byteLength, streamError };
  }

  const events: DumpStreamEvent[] = [];
  let byteLength = 0;
  let streamError: string | null = null;
  // Count bytes off the tee separately from SSE parsing because parseSSEStream
  // consumes the stream — the byte counter on the other branch keeps the
  // wire-byte total honest.
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
      // The parser path reports the real error if the stream broke; counting
      // failure is non-fatal on its own.
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

const resolveUpstreamRef = async (id: string | null): Promise<DumpUpstreamRef | null> => {
  if (!id) return null;
  const upstream = await getRepo().upstreams.getById(id);
  if (!upstream) return null;
  return { id: upstream.id, name: upstream.name, kind: upstream.provider };
};
