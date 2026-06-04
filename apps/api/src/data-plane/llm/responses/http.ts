import type { Context } from 'hono';

import { respondResponses } from './respond.ts';
import { responsesServe } from './serve.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

const CODEX_AUTO_REVIEW_ALIAS = 'codex-auto-review';
const CODEX_AUTO_REVIEW_TARGET = 'gpt-5.4';

// Codex sends auto-review requests over the Responses wire API as a
// `codex-auto-review` model id; rewrite at the entry so downstream routing,
// performance telemetry, and usage accounting all see the real model name
// (and the `low` reasoning effort the alias implies).
//
// References (codex @ e7bffc5a20e92cbc64d6c16a1b257d0b2e4cd5df):
//   codex-rs/model-provider/src/provider.rs#L73-L96
//   codex-rs/codex-api/src/endpoint/responses.rs#L102-L134
const rewriteResponsesEntryModelAlias = (payload: ResponsesPayload): ResponsesPayload => {
  if (payload.model !== CODEX_AUTO_REVIEW_ALIAS) return payload;
  return {
    ...payload,
    model: CODEX_AUTO_REVIEW_TARGET,
    reasoning: { ...(payload.reasoning ?? {}), effort: 'low' },
  };
};

// Compact carries no `reasoning` field, so only the model swap applies.
const rewriteResponsesCompactEntryModelAlias = (payload: ResponsesPayload): ResponsesPayload =>
  payload.model === CODEX_AUTO_REVIEW_ALIAS ? { ...payload, model: CODEX_AUTO_REVIEW_TARGET } : payload;

// OpenAI's verbatim previous_response_not_found envelope. Codex compares this
// body byte-for-byte against upstream — see the cross-references on
// `PreviousResponseNotFoundError` in serve-prep.ts.
const previousResponseNotFoundResponse = (id: string): Response =>
  Response.json(
    {
      error: {
        message: `Previous response with id '${id}' not found.`,
        type: 'invalid_request_error',
        param: 'previous_response_id',
        code: 'previous_response_not_found',
      },
    },
    { status: 400 },
  );

export const responsesHttp = {
  generate: async (c: Context): Promise<Response> => {
    const payload = rewriteResponsesEntryModelAlias(await c.req.json<ResponsesPayload>());
    const wantsStream = payload.stream === true;
    const ctx = createGatewayCtxFromHono(c, wantsStream);
    const store = createResponsesHttpStore(ctx.apiKeyId, payload.store ?? undefined);
    let result;
    try {
      result = await responsesServe.generate({ payload, ctx, store, snapshotMode: payload.store === false ? 'none' : 'append' });
    } catch (error) {
      // Only the verbatim previous_response_not_found envelope is rendered
      // here; every other error propagates up to the Hono onError handler.
      if (error instanceof PreviousResponseNotFoundError) return previousResponseNotFoundResponse(error.previousResponseId);
      throw error;
    }
    const { response } = await respondResponses(c, result, wantsStream, ctx);
    return response;
  },

  compact: async (c: Context): Promise<Response> => {
    const payload = rewriteResponsesCompactEntryModelAlias(await c.req.json<ResponsesPayload>());
    const ctx = createGatewayCtxFromHono(c, false);
    const store = createResponsesHttpStore(ctx.apiKeyId, payload.store ?? undefined);
    let result;
    try {
      result = await responsesServe.compact({ payload, ctx, store });
    } catch (error) {
      if (error instanceof PreviousResponseNotFoundError) return previousResponseNotFoundResponse(error.previousResponseId);
      throw error;
    }
    // Compact always renders a non-streaming body; respondResponses already
    // handles the result-vs-events split internally.
    if (result.type === 'result') return Response.json(result.result);
    const { response } = await respondResponses(c, result, false, ctx);
    return response;
  },
};
