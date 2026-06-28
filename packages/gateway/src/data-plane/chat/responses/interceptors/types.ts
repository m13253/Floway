import type { TokenUsage } from '../../../../repo/types.ts';
import type { ChatGatewayCtx } from '../../shared/gateway-ctx.ts';
import type { Interceptor } from '@floway-dev/interceptor';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesInputItem, ResponsesPayload, ResponsesResult, ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult, ResponsesInvocation as WireResponsesInvocation, TelemetryModelIdentity } from '@floway-dev/provider';

// Wire `ResponsesPayload.input` is `string | InputItem[]`. The HTTP/WS entries
// normalize the wire string to a single synthetic user-role message before
// any serve logic runs, so every reader past the entry sees array shape.
// This is the gateway-internal narrowed view; the wire-shape `ResponsesPayload`
// continues to live on the entry boundary, on provider-call bodies, and in
// translate-package signatures (those interface with foreign wire shapes that
// haven't been normalized).
export type CanonicalResponsesPayload = Omit<ResponsesPayload, 'input'> & {
  input: ResponsesInputItem[];
};

// Lifts a wire `ResponsesPayload` into the gateway's internal canonical form
// by replacing a bare-string `input` with a single synthetic user-role
// message. Used at every boundary that produces a wire payload destined for
// the gateway's serve/attempt pipeline: the HTTP/WS entries on a fresh
// request, and the translate package's `messages → responses` /
// `chat-completions → responses` / `gemini → responses` outputs flowing
// into `responsesAttempt`.
export const canonicalizeResponsesPayload = (payload: ResponsesPayload): CanonicalResponsesPayload => ({
  ...payload,
  input: typeof payload.input === 'string'
    ? [{ type: 'message', role: 'user', content: payload.input }]
    : payload.input,
});

export interface ResponsesInvocation extends Omit<WireResponsesInvocation, 'payload'> {
  payload: CanonicalResponsesPayload;
}

// The chain runner produces an event stream for both actions — the attempt
// post-processes it into a single `response.compaction` envelope when the
// caller's intent action was 'compact'. `modelIdentity` and `usage` carry
// the per-turn attribution forward so the http layer's `ctx.dump` records
// the success path identically to streaming generate.
export type ResponsesAttemptResult =
  | ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
  | {
    readonly type: 'result';
    readonly result: ResponsesResult;
    readonly modelIdentity: TelemetryModelIdentity;
    readonly usage: TokenUsage | null;
  };

export type ResponsesInterceptor = Interceptor<
  ResponsesInvocation,
  ChatGatewayCtx,
  ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>
>;
