import { responsesAttempt } from './attempt.ts';
import type { ResponsesAttemptResult } from './interceptors/types.ts';
import { prepareResponsesServePlan } from './serve-prep.ts';
import { isAttemptSuccess } from '../shared/errors.ts';
import type { ChatGatewayCtx } from '../shared/gateway-ctx.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { ResponsesStreamEvent } from '@floway-dev/protocols/responses';
import type { ExecuteResult } from '@floway-dev/provider';
import type { CanonicalResponsesPayload } from '@floway-dev/translate/via-responses/responses-items';

export interface ResponsesServeGenerateArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export interface ResponsesServeCompactArgs {
  readonly payload: CanonicalResponsesPayload;
  readonly ctx: ChatGatewayCtx;
  readonly headers: Headers;
}

export const responsesServe = {
  generate: async (args: ResponsesServeGenerateArgs): Promise<ExecuteResult<ProtocolFrame<ResponsesStreamEvent>>> => {
    const { payload, ctx, headers } = args;
    const plan = await prepareResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    // Iterate the narrowed candidates: success (SSE stream opened) is the
    // final answer; per-candidate failures fall through so a transient
    // 5xx/429/network does not become the request's verdict when another
    // candidate can serve. The last failure surfaces verbatim on exhaustion.
    let lastFailure: ExecuteResult<ProtocolFrame<ResponsesStreamEvent>> | undefined;
    for (const candidate of plan.candidates) {
      const result = await responsesAttempt.generate({ payload: plan.prepared, ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },

  compact: async (args: ResponsesServeCompactArgs): Promise<ResponsesAttemptResult> => {
    const { payload, ctx, headers } = args;
    // Compact accepts `previous_response_id` (the official endpoint documents
    // it). When present serve-prep expands it the same way generate does so
    // the upstream sees the same item_reference + current input shape.
    //
    // For non-responses targets the responses-compact-shim picks up the
    // request inside the interceptor chain, flips action='compact' to
    // 'generate', runs a SUMMARIZATION_PROMPT turn through translation, and
    // re-tags the result as compact on the way out.
    const plan = await prepareResponsesServePlan({ payload, ctx });
    if (plan.kind === 'failure') return plan.result;
    let lastFailure: ResponsesAttemptResult | undefined;
    for (const candidate of plan.candidates) {
      const result = await responsesAttempt.invoke({ payload: plan.prepared, action: 'compact', ctx, candidate, headers });
      if (isAttemptSuccess(result)) return result;
      lastFailure = result;
    }
    return lastFailure!;
  },
};
