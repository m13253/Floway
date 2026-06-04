import type { Context } from 'hono';

import { respondChatCompletions } from './respond.ts';
import { chatCompletionsServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';

export const chatCompletionsHttp = {
  generate: async (c: Context): Promise<Response> => {
    const payload = await c.req.json<ChatCompletionsPayload>();
    const wantsStream = payload.stream === true;
    // Read the caller's intent BEFORE any interceptor mutates
    // `payload.stream_options.include_usage`. Capturing it here means the
    // downstream renderer never needs to consult per-request Hono context
    // slots — the value lives in this http-entry closure for the duration of
    // the request.
    const includeUsageChunk = payload.stream_options?.include_usage === true;
    const ctx = createGatewayCtxFromHono(c, wantsStream);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    const result = await chatCompletionsServe.generate({ payload, ctx, store });
    const { response } = await respondChatCompletions(c, result, wantsStream, includeUsageChunk, ctx);
    return response;
  },
};
