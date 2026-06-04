import type { Context } from 'hono';

import { respondResponses } from './respond.ts';
import { responsesServe } from './serve.ts';
import { PreviousResponseNotFoundError } from './serve-prep.ts';
import { createResponsesHttpStore } from './items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { ResponsesPayload } from '@floway-dev/protocols/responses';

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
    const payload = await c.req.json<ResponsesPayload>();
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
    const payload = await c.req.json<ResponsesPayload>();
    const ctx = createGatewayCtxFromHono(c, false);
    const store = createResponsesHttpStore(ctx.apiKeyId, payload.store ?? undefined);
    const result = await responsesServe.compact({ payload, ctx, store });
    // Compact always renders a non-streaming body; respondResponses already
    // handles the result-vs-events split internally.
    if (result.type === 'result') return Response.json(result.result);
    const { response } = await respondResponses(c, result, false, ctx);
    return response;
  },
};
