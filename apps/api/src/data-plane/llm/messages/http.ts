import type { Context } from 'hono';

import { respondMessages } from './respond.ts';
import { messagesServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { MessagesPayload } from '@floway-dev/protocols/messages';

const parseAnthropicBeta = (raw: string | undefined): readonly string[] | undefined => {
  if (!raw) return undefined;
  const values = raw
    .split(',')
    .map(part => part.trim())
    .filter(part => part.length > 0);
  return values.length > 0 ? values : undefined;
};

// Reject `anthropic_beta` / `betas` in the body; the Messages protocol carries
// them via the `anthropic-beta` HTTP header. Matches the legacy entry's
// pre-flight check.
const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, 'anthropic_beta')) return 'anthropic_beta';
  if (Object.hasOwn(record, 'betas')) return 'betas';
  return undefined;
};

const bodyAnthropicBetaResponse = (param: string): Response =>
  Response.json(
    {
      error: {
        message: `${param} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
        type: 'invalid_request_error',
        param,
      },
    },
    { status: 400 },
  );

export const messagesHttp = {
  generate: async (c: Context): Promise<Response> => {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const wantsStream = payload.stream === true;
    const ctx = createGatewayCtxFromHono(c, wantsStream);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    const result = await messagesServe.generate({ payload, ctx, store, anthropicBeta });
    const { response } = await respondMessages(c, result, wantsStream, ctx);
    return response;
  },

  countTokens: async (c: Context): Promise<Response> => {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) return bodyAnthropicBetaResponse(rejectedBetaParam);

    const ctx = createGatewayCtxFromHono(c, false);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    const anthropicBeta = parseAnthropicBeta(c.req.header('anthropic-beta'));
    const result = await messagesServe.countTokens({ payload, ctx, store, anthropicBeta });
    const { response } = await respondMessages(c, result, false, ctx);
    return response;
  },
};
