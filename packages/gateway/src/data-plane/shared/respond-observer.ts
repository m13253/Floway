import type { TokenUsage } from '../../repo/types.ts';
import type { GatewayCtx } from '../llm/shared/gateway-ctx.ts';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import type { InternalErrorResult, PlainResult, TelemetryModelIdentity, UpstreamErrorResult } from '@floway-dev/provider';

// Per-request capture of the inbound request bytes and the outbound response
// bytes. The HTTP entry point assembles this once after its handler resolves
// and hands it to every observer's `finalize` hook through
// `captureResponseAndFinalize` — observers that ignore body bytes (telemetry,
// audit) drop the parameter and only consume their accumulated lifecycle
// state.
export interface RespondCapture {
  readonly request: {
    readonly method: string;
    readonly path: string;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly contentType: string;
    readonly body: Uint8Array;
    readonly streamError: string | null;
  };
  readonly response: {
    readonly status: number;
    readonly headers: ReadonlyArray<readonly [string, string]>;
    readonly contentType: string;
    readonly isStream: boolean;
    readonly bytes: Uint8Array;
    readonly streamError: string | null;
  };
  readonly startedAt: number;
  readonly completedAt: number;
}

// Lifecycle hooks the per-source `respond` layer emits at every decision
// point worth observing from outside: pre-pipeline failures, the protocol
// frame stream, success identity/usage, and failure reasons. Cross-cutting
// concerns (the request dump today, telemetry/audit tomorrow) implement this
// interface, get installed by `createGatewayCtxFromHono`, and translate the
// events into their own per-request state. Every method is optional — an
// observer subscribes only to the events it actually consumes.
//
// `finalize` runs once per request after the response has settled, via the
// HTTP entry point's explicit `captureResponseAndFinalize(ctx, response)`
// call. The hook receives the same typed `GatewayCtx` the source-side respond
// layer saw plus a `RespondCapture` summarising the on-wire request/response
// bytes. The entry point schedules the hook through the runtime's background
// scheduler so observer work never delays the client response.
export interface RespondObserver {
  upstreamError?(result: UpstreamErrorResult): void;
  internalError?(result: InternalErrorResult): void;
  plain?(result: PlainResult): void;
  frame?(sse: SseFrame | null): void;
  success?(identity: TelemetryModelIdentity, usage: TokenUsage | null): void;
  error?(reason: string): void;
  finalize?(ctx: GatewayCtx, capture: RespondCapture): Promise<void>;
}

// Errors from one observer must not silence the rest of the pipeline. Catch
// per-observer and log; the request still completes for the client.
const dispatch = (ctx: GatewayCtx, fn: (o: RespondObserver) => void): void => {
  for (const observer of ctx.respondObservers) {
    try {
      fn(observer);
    } catch (err) {
      console.error('[respond-observer] observer threw', err);
    }
  }
};

const oneLineMessage = (err: unknown): string => {
  const msg = (err instanceof Error ? err.message : String(err)).replace(/\s+/g, ' ').trim();
  return msg.length > 500 ? `${msg.slice(0, 497)}…` : msg;
};

export const notifyUpstreamError = (ctx: GatewayCtx, result: UpstreamErrorResult): void =>
  dispatch(ctx, o => o.upstreamError?.(result));

export const notifyInternalError = (ctx: GatewayCtx, result: InternalErrorResult): void =>
  dispatch(ctx, o => o.internalError?.(result));

export const notifyPlain = (ctx: GatewayCtx, result: PlainResult): void =>
  dispatch(ctx, o => o.plain?.(result));

export const notifySuccess = (ctx: GatewayCtx, identity: TelemetryModelIdentity, usage: TokenUsage | null): void =>
  dispatch(ctx, o => o.success?.(identity, usage));

export const notifyError = (ctx: GatewayCtx, error: string | unknown): void => {
  const reason = typeof error === 'string' ? error : oneLineMessage(error);
  dispatch(ctx, o => o.error?.(reason));
};

// Wrap a source's `result.events` so every protocol frame is mirrored to
// every registered observer via `frame()`. The original frames pass through
// unchanged; the SSE serialisation happens here so each observer sees the
// same wire-shape view of the upstream stream regardless of what the client
// ended up negotiating. A serialisation throw is contained and surfaces as
// a synthetic `serialize_error` SSE frame so observers can see where the
// gap is rather than silently dropping the rest of the stream.
export const tapFrames = async function* <TEvent>(
  source: AsyncIterable<ProtocolFrame<TEvent>>,
  ctx: GatewayCtx,
  toSSE: (frame: ProtocolFrame<TEvent>) => SseFrame | null,
): AsyncIterable<ProtocolFrame<TEvent>> {
  for await (const frame of source) {
    let sse: SseFrame | null;
    try {
      sse = toSSE(frame);
    } catch (err) {
      sse = { type: 'sse', event: 'serialize_error', data: err instanceof Error ? err.message : String(err) };
    }
    dispatch(ctx, o => o.frame?.(sse));
    yield frame;
  }
};

// Re-export concrete observers + the registry installer so consumers reach
// both the contract and the assembled observer set through this single file.
// Pattern mirrors `responses/interceptors/server-tool-shim.ts` +
// `responses/interceptors/server-tools/`: a thin shim file alongside a
// directory of concrete impls, composed via an `index.ts` that the shim
// re-exports.
export * from './respond-observers/index.ts';

const headerPairs = (headers: Headers): Array<[string, string]> => {
  const pairs: Array<[string, string]> = [];
  headers.forEach((value, name) => { pairs.push([name, value]); });
  return pairs;
};

// Closes out the per-request observer lifecycle. The handler hands its final
// `Response` here; if any observer opted in, the response body is tee'd so
// the client gets bytes flowing while a background reader accumulates the
// other half into a `RespondCapture` and dispatches `finalize` to every
// observer. The replacement `Response` carries identical status, statusText,
// and headers — the tee is operationally invisible to the client.
//
// When no observer opted in the original response passes through verbatim and
// no body tee happens, so the steady-state cost on opt-out keys is one
// length check.
export const captureResponseAndFinalize = (ctx: GatewayCtx, response: Response): Response => {
  if (ctx.respondObservers.length === 0) return response;

  const responseStatus = response.status;
  const responseHeaders = headerPairs(response.headers);
  const contentType = response.headers.get('content-type') ?? '';
  const isStream = contentType.startsWith('text/event-stream');

  if (response.body === null) {
    ctx.backgroundScheduler(finalizeAll(ctx, {
      status: responseStatus,
      headers: responseHeaders,
      contentType,
      isStream,
      bytes: new Uint8Array(),
      streamError: null,
    }));
    return response;
  }

  const [forClient, forCapture] = response.body.tee();
  ctx.backgroundScheduler((async () => {
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
      streamError = oneLineMessage(err);
    }
    const bytes = new Uint8Array(total);
    let offset = 0;
    for (const chunk of chunks) { bytes.set(chunk, offset); offset += chunk.byteLength; }
    await finalizeAll(ctx, {
      status: responseStatus,
      headers: responseHeaders,
      contentType,
      isStream,
      bytes,
      streamError,
    });
  })());

  return new Response(forClient, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers,
  });
};

const finalizeAll = async (ctx: GatewayCtx, response: RespondCapture['response']): Promise<void> => {
  const capture: RespondCapture = {
    request: {
      method: ctx.requestSnapshot.method,
      path: ctx.requestSnapshot.path,
      headers: ctx.requestSnapshot.headers,
      contentType: ctx.requestSnapshot.contentType,
      body: ctx.requestSnapshot.body,
      streamError: ctx.requestSnapshot.streamError,
    },
    response,
    startedAt: ctx.requestStartedWallMs,
    completedAt: Date.now(),
  };
  for (const observer of ctx.respondObservers) {
    if (!observer.finalize) continue;
    try {
      await observer.finalize(ctx, capture);
    } catch (err) {
      console.error('[respond-observer] finalize threw', err);
    }
  }
};
