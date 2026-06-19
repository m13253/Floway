import type { MiddlewareHandler } from 'hono';

import type { ApiKey } from '../../repo/types.ts';
import { backgroundSchedulerFromContext } from '../../runtime/background.ts';
import { getDumpBroker, getDumpStore } from '../../runtime/dump.ts';
import { ulid } from '../../shared/ulid.ts';
import { parseSSEStream } from '@floway-dev/protocols/common';
import type {
  DumpRecord,
  DumpResponseBody,
  DumpStreamEvent,
} from '@floway-dev/protocols/dump';
import { parseGeminiStream } from '@floway-dev/protocols/gemini';

// We intentionally do NOT redact `authorization`, `x-api-key`, `cookie`, or
// any other header. The api-key value is already in our own database; the
// dump exposes no secret the operator does not already control. See the
// "No header redaction" non-goal in
// docs/specs/2026-06-19-request-dump-design.md. Do not "fix" this by
// adding redaction — the dashboard already restricts dump reads to the
// owning operator.
const headerPairs = (h: Headers): Array<[string, string]> => {
  const out: Array<[string, string]> = [];
  h.forEach((v, k) => out.push([k, v]));
  return out;
};

const isTextContentType = (contentType: string | null): boolean => {
  if (!contentType) return false;
  return (
    contentType.startsWith('text/')
    || contentType.startsWith('application/json')
    || contentType.startsWith('application/x-ndjson')
    || contentType.startsWith('application/javascript')
    || contentType.includes('+json')
    || contentType.includes('charset=')
  );
};

// Encode the body for the dump bundle. Text bodies decode to utf-8;
// non-text bodies are base64'd and we append `;base64` to the recorded
// content-type header so the SPA knows to base64-decode on display.
const encodeBody = (bytes: Uint8Array, contentType: string | null): { body: string; base64: boolean } => {
  if (bytes.length === 0) return { body: '', base64: false };
  if (isTextContentType(contentType)) return { body: new TextDecoder().decode(bytes), base64: false };
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return { body: btoa(bin), base64: true };
};

const annotateBase64ContentType = (headers: Array<[string, string]>, base64: boolean): Array<[string, string]> => {
  if (!base64) return headers;
  return headers.map(([k, v]): [string, string] =>
    k.toLowerCase() === 'content-type' ? [k, `${v};base64`] : [k, v]);
};

const errorSummary = (err: unknown): string => {
  if (err instanceof Error) return (err.stack ?? err.message).split('\n', 1)[0]!;
  return String(err).split('\n', 1)[0]!;
};

interface DumpAccounting {
  upstream?: string | null;
  model?: string | null;
  inputTokens?: number | null;
  outputTokens?: number | null;
}

interface CapturedBody {
  body: DumpResponseBody;
  bodyBase64: boolean;
  streamingError: unknown;
}

const captureSSE = async (forCapture: ReadableStream<Uint8Array>, startedAt: number): Promise<CapturedBody> => {
  const events: DumpStreamEvent[] = [];
  let streamingError: unknown = null;
  try {
    for await (const frame of parseSSEStream(forCapture)) {
      events.push({ event: frame.event ?? null, data: frame.data, ts: Date.now() - startedAt });
    }
  } catch (err) {
    streamingError = err;
  }
  return { body: { type: 'stream', events }, bodyBase64: false, streamingError };
};

const captureGeminiStream = async (forCapture: ReadableStream<Uint8Array>, startedAt: number): Promise<CapturedBody> => {
  const events: DumpStreamEvent[] = [];
  let streamingError: unknown = null;
  try {
    for await (const chunk of parseGeminiStream(forCapture)) {
      events.push({ event: null, data: chunk.chunk, ts: Date.now() - startedAt });
    }
  } catch (err) {
    streamingError = err;
  }
  return { body: { type: 'stream', events }, bodyBase64: false, streamingError };
};

const captureBytes = async (forCapture: ReadableStream<Uint8Array>, contentType: string | null): Promise<CapturedBody> => {
  let streamingError: unknown = null;
  let bytes = new Uint8Array();
  try {
    bytes = new Uint8Array(await new Response(forCapture).arrayBuffer());
  } catch (err) {
    streamingError = err;
  }
  const encoded = encodeBody(bytes, contentType);
  return { body: { type: 'bytes', body: encoded.body }, bodyBase64: encoded.base64, streamingError };
};

export const captureRequestDump = (): MiddlewareHandler => async (c, next) => {
  const apiKey = c.get('apiKey') as ApiKey | undefined;
  if (apiKey?.dumpRetentionSeconds === undefined || apiKey.dumpRetentionSeconds === null) return await next();
  // The Gemini dispatcher routes :countTokens / :generateContent /
  // :streamGenerateContent off a single Hono path, but only the generate
  // variants invoke a billable upstream model — :countTokens is a local
  // pre-flight that the spec explicitly excludes from capture.
  if (c.req.path.startsWith('/v1beta/models/') && c.req.path.endsWith(':countTokens')) return await next();

  const startedAt = Date.now();
  const recordId = ulid();
  const requestHeaders = headerPairs(c.req.raw.headers);
  const requestBodyBytes = c.req.raw.body
    ? new Uint8Array(await new Response(c.req.raw.body).arrayBuffer())
    : new Uint8Array();

  // Replay the buffered bytes back into the request so the downstream handler
  // can `c.req.json()` / `c.req.text()` / `c.req.formData()` normally.
  const replayReq = new Request(c.req.raw.url, {
    method: c.req.raw.method,
    headers: c.req.raw.headers,
    body: requestBodyBytes.length > 0 ? requestBodyBytes : null,
    redirect: c.req.raw.redirect,
  });
  Object.defineProperty(c.req, 'raw', { value: replayReq, configurable: true });

  // Hono's compose runs its onError before our `await next()` resumes, so a
  // throw from the inner handler comes back to us as `c.error` plus a 500
  // body on `c.res`, not a re-thrown rejection. We treat `c.error` as the
  // canonical "upstream blew up" signal and record `none`/status:0, ignoring
  // whatever placeholder envelope the error handler stamped on `c.res`.
  let upstreamError: unknown = null;
  try {
    await next();
  } catch (err) {
    upstreamError = err;
  }
  if (upstreamError === null && c.error !== undefined) upstreamError = c.error;

  const hasResponse = upstreamError === null;
  const responseStatus = hasResponse ? c.res.status : 0;
  const rawResponseHeaders = hasResponse ? headerPairs(c.res.headers) : [];
  const responseContentType = hasResponse ? c.res.headers.get('content-type') : null;
  const isSSE = responseContentType?.startsWith('text/event-stream') ?? false;
  // Gemini's `:streamGenerateContent` returns chunked JSON framed as
  // `data: <json>\n\n`. In production our gateway re-emits this through
  // `streamSSE` so the response carries `text/event-stream` (handled by the
  // SSE branch above), but we still keep this branch so a future passthrough
  // path that surfaces the upstream `application/json` body verbatim parses
  // into per-chunk events instead of a single bytes blob.
  const isGeminiStream = (responseContentType?.startsWith('application/json') ?? false)
    && c.req.path.includes(':streamGenerateContent');

  // Set up the body capture pipeline. We tee the response body so the client
  // continues to receive bytes while the capture half drains in the
  // background; finalize-and-persist runs through `waitUntil` so the response
  // is not held open on the parser or the storage write.
  let capturedBodyPromise: Promise<CapturedBody>;
  if (!hasResponse) {
    capturedBodyPromise = Promise.resolve({ body: { type: 'none' }, bodyBase64: false, streamingError: null });
  } else if (!c.res.body) {
    capturedBodyPromise = Promise.resolve({ body: { type: 'bytes', body: '' }, bodyBase64: false, streamingError: null });
  } else {
    const [forClient, forCapture] = c.res.body.tee();
    c.res = new Response(forClient, { status: c.res.status, headers: c.res.headers });
    if (isSSE) {
      capturedBodyPromise = captureSSE(forCapture, startedAt);
    } else if (isGeminiStream) {
      capturedBodyPromise = captureGeminiStream(forCapture, startedAt);
    } else {
      capturedBodyPromise = captureBytes(forCapture, responseContentType);
    }
  }

  const reqContentType = c.req.raw.headers.get('content-type');
  const reqEncoded = encodeBody(requestBodyBytes, reqContentType);
  const path = c.req.path + new URL(c.req.url).search;
  const method = c.req.method;
  const reqPath = c.req.path;

  // Defer reading dumpAccounting until the capture pipeline settles — the
  // streaming respond paths set it inside their stream-end `finally`, which
  // fires after the upstream stream has been fully consumed by `forCapture`.
  const finalize = async (): Promise<void> => {
    const captured = await capturedBodyPromise;
    const completedAt = Date.now();
    const accounting = c.get('dumpAccounting') as DumpAccounting | undefined;
    const finalError = upstreamError ?? captured.streamingError;
    const record: DumpRecord = {
      meta: {
        id: recordId,
        startedAt,
        completedAt,
        method,
        path,
        status: responseStatus,
        upstream: accounting?.upstream ?? null,
        model: accounting?.model ?? null,
        inputTokens: accounting?.inputTokens ?? null,
        outputTokens: accounting?.outputTokens ?? null,
        durationMs: completedAt - startedAt,
        error: finalError !== null ? errorSummary(finalError) : null,
      },
      request: {
        method,
        path: reqPath,
        headers: annotateBase64ContentType(requestHeaders, reqEncoded.base64),
        body: reqEncoded.body,
      },
      response: {
        status: responseStatus,
        headers: annotateBase64ContentType(rawResponseHeaders, captured.bodyBase64),
        ...captured.body,
      },
    };
    try {
      await getDumpStore().put(apiKey.id, record);
    } catch (err) {
      console.error('[dump-store]', err);
    }
    try {
      getDumpBroker().publish(apiKey.id, record.meta);
    } catch (err) {
      console.error('[dump-broker]', err);
    }
  };

  backgroundSchedulerFromContext(c)(finalize());
};
