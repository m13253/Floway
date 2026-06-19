import type { MiddlewareHandler } from 'hono';

import { getRepo } from '../../repo/index.ts';
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

// We intentionally do NOT redact `authorization`, `x-api-key`, `cookie`, or
// any other header. The api-key value is already in our own database; the
// dump exposes no secret the operator does not already control. The
// dashboard restricts dump reads to the owning operator, so verbatim
// capture stays scoped to that operator's own surface area.
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
  responseBytes: number;
  streamingError: unknown;
}

const captureSSE = async (forCapture: ReadableStream<Uint8Array>, startedAt: number): Promise<CapturedBody> => {
  const events: DumpStreamEvent[] = [];
  let streamingError: unknown = null;
  let responseBytes = 0;
  // Tap the raw stream for byte counting before re-feeding it to parseSSEStream.
  const counted = forCapture.pipeThrough(new TransformStream({
    transform(chunk, controller) { responseBytes += chunk.byteLength; controller.enqueue(chunk); },
  }));
  try {
    for await (const frame of parseSSEStream(counted)) {
      events.push({ event: frame.event ?? null, data: frame.data, ts: Date.now() - startedAt });
    }
  } catch (err) {
    streamingError = err;
  }
  return { body: { type: 'stream', events }, bodyBase64: false, responseBytes, streamingError };
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
  return { body: { type: 'bytes', body: encoded.body }, bodyBase64: encoded.base64, responseBytes: bytes.byteLength, streamingError };
};

export const captureRequestDump = (): MiddlewareHandler => async (c, next) => {
  const apiKey = c.get('apiKey') as ApiKey;
  if (apiKey.dumpRetentionSeconds === null) return await next();
  // `:countTokens` is a local pre-check that does not call upstream, so it
  // is not captured even though it shares the Gemini dispatcher's path with
  // the generate variants.
  if (c.req.path.startsWith('/v1beta/models/') && c.req.path.endsWith(':countTokens')) return await next();

  const startedAt = Date.now();
  const recordId = ulid();
  const requestHeaders = headerPairs(c.req.raw.headers);

  // Tee the request body so the downstream handler streams its half to
  // upstream while the capture half drains into our buffer in parallel.
  // Passing the original Request as `new Request`'s first arg preserves
  // signal/cache/credentials/referrer — the second arg only overrides what
  // it explicitly names. `duplex: 'half'` is required by Node 18+ and
  // workerd whenever a Request is built with a ReadableStream body.
  let capturedRequestBytesPromise: Promise<Uint8Array>;
  if (c.req.raw.body === null) {
    capturedRequestBytesPromise = Promise.resolve(new Uint8Array());
  } else {
    const [forHandler, forCapture] = c.req.raw.body.tee();
    const replayReq = new Request(c.req.raw, {
      body: forHandler,
      duplex: 'half',
    } as RequestInit & { duplex: 'half' });
    Object.defineProperty(c.req, 'raw', { value: replayReq, configurable: true });
    capturedRequestBytesPromise = (async () => {
      const reader = forCapture.getReader();
      const chunks: Uint8Array[] = [];
      let total = 0;
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        chunks.push(value);
        total += value.byteLength;
      }
      const out = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) { out.set(chunk, offset); offset += chunk.byteLength; }
      return out;
    })();
  }

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

  // Set up the body capture pipeline. We tee the response body so the client
  // continues to receive bytes while the capture half drains in the
  // background; finalize-and-persist runs through `waitUntil` so the response
  // is not held open on the parser or the storage write.
  let capturedBodyPromise: Promise<CapturedBody>;
  if (!hasResponse) {
    capturedBodyPromise = Promise.resolve({ body: { type: 'none' }, bodyBase64: false, responseBytes: 0, streamingError: null });
  } else if (!c.res.body) {
    capturedBodyPromise = Promise.resolve({ body: { type: 'bytes', body: '' }, bodyBase64: false, responseBytes: 0, streamingError: null });
  } else {
    const [forClient, forCapture] = c.res.body.tee();
    c.res = new Response(forClient, { status: c.res.status, headers: c.res.headers });
    if (isSSE) {
      capturedBodyPromise = captureSSE(forCapture, startedAt);
    } else {
      capturedBodyPromise = captureBytes(forCapture, responseContentType);
    }
  }

  const reqContentType = c.req.raw.headers.get('content-type');
  const queryIdx = c.req.url.indexOf('?');
  const path = queryIdx >= 0 ? c.req.path + c.req.url.slice(queryIdx) : c.req.path;
  const method = c.req.method;

  // Defer reading dumpAccounting until the capture pipeline settles — the
  // streaming respond paths set it inside their stream-end `finally`, which
  // fires after the upstream stream has been fully consumed by `forCapture`.
  const finalize = async (): Promise<void> => {
    const requestBodyBytes = await capturedRequestBytesPromise;
    const reqEncoded = encodeBody(requestBodyBytes, reqContentType);
    const captured = await capturedBodyPromise;
    const completedAt = Date.now();
    const accounting = c.get('dumpAccounting') as DumpAccounting | undefined;
    const finalError = upstreamError ?? captured.streamingError;
    // Resolve upstream id → {name, kind} from the repo so the dashboard
    // can show a human label colored by provider kind without round-tripping.
    // A deleted upstream falls back to id-as-name with kind:'unknown'.
    let upstreamRef: { id: string; name: string; kind: string } | null = null;
    if (accounting?.upstream) {
      const row = await getRepo().upstreams.getById(accounting.upstream);
      upstreamRef = row
        ? { id: row.id, name: row.name, kind: row.provider }
        : { id: accounting.upstream, name: accounting.upstream, kind: 'unknown' };
    }
    const record: DumpRecord = {
      meta: {
        id: recordId,
        startedAt,
        completedAt,
        method,
        path,
        status: responseStatus,
        upstream: upstreamRef,
        model: accounting?.model ?? null,
        inputTokens: accounting?.inputTokens ?? null,
        outputTokens: accounting?.outputTokens ?? null,
        requestBytes: requestBodyBytes.byteLength,
        responseBytes: captured.responseBytes,
        durationMs: completedAt - startedAt,
        error: finalError !== null ? errorSummary(finalError) : null,
      },
      request: {
        method,
        path,
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
      getDumpBroker().publish(apiKey.id, record.meta);
    } catch (err) {
      // Re-throw with keyId+recordId context so the scheduler's logger
      // (`[background] ...` on Node, CF logs on workerd) shows what the
      // failure was tied to. The store and broker share one catch because
      // either failure has identical observability needs.
      const message = err instanceof Error ? err.message : String(err);
      throw new Error(`[dump] keyId=${apiKey.id} recordId=${record.meta.id}: ${message}`, { cause: err });
    }
  };

  backgroundSchedulerFromContext(c)(finalize());
};
