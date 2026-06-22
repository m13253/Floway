import type { Context } from 'hono';

import type { TokenUsage } from '../../repo/types.ts';
import type { ProtocolFrame, SseFrame } from '@floway-dev/protocols/common';
import type { InternalErrorResult, PlainResult, TelemetryModelIdentity, UpstreamErrorResult } from '@floway-dev/provider';

// Lifecycle hooks the per-source `respond` layer emits at every decision
// point worth observing from outside: pre-pipeline failures, the protocol
// frame stream, success identity/usage, and failure reasons. Cross-cutting
// concerns (the request dump today, telemetry/audit tomorrow) register an
// implementation against the Hono context at middleware entry and translate
// these events into their own per-request state. Every method is optional —
// an observer subscribes only to the events it actually consumes.
export interface RespondObserver {
  upstreamError?(result: UpstreamErrorResult): void;
  internalError?(result: InternalErrorResult): void;
  plain?(result: PlainResult): void;
  frame?(sse: SseFrame | null): void;
  success?(identity: TelemetryModelIdentity, usage: TokenUsage | null): void;
  error?(reason: string): void;
}

const KEY = 'respondObservers';

export const addRespondObserver = (c: Context, observer: RespondObserver): void => {
  const list = (c.get(KEY) as RespondObserver[] | undefined) ?? [];
  list.push(observer);
  c.set(KEY, list);
};

// Errors from one observer must not silence the rest of the pipeline. Catch
// per-observer and log; the request still completes for the client.
const dispatch = (c: Context, fn: (o: RespondObserver) => void): void => {
  const list = c.get(KEY) as RespondObserver[] | undefined;
  if (!list) return;
  for (const observer of list) {
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

export const notifyUpstreamError = (c: Context, result: UpstreamErrorResult): void =>
  dispatch(c, o => o.upstreamError?.(result));

export const notifyInternalError = (c: Context, result: InternalErrorResult): void =>
  dispatch(c, o => o.internalError?.(result));

export const notifyPlain = (c: Context, result: PlainResult): void =>
  dispatch(c, o => o.plain?.(result));

export const notifySuccess = (c: Context, identity: TelemetryModelIdentity, usage: TokenUsage | null): void =>
  dispatch(c, o => o.success?.(identity, usage));

export const notifyError = (c: Context, error: string | unknown): void => {
  const reason = typeof error === 'string' ? error : oneLineMessage(error);
  dispatch(c, o => o.error?.(reason));
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
  c: Context,
  toSSE: (frame: ProtocolFrame<TEvent>) => SseFrame | null,
): AsyncIterable<ProtocolFrame<TEvent>> {
  for await (const frame of source) {
    let sse: SseFrame | null;
    try {
      sse = toSSE(frame);
    } catch (err) {
      sse = { type: 'sse', event: 'serialize_error', data: err instanceof Error ? err.message : String(err) };
    }
    dispatch(c, o => o.frame?.(sse));
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
