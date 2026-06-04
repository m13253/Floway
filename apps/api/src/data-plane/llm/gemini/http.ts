import type { Context } from 'hono';

import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { geminiServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { GeminiContent, GeminiPayload } from '@floway-dev/protocols/gemini';

// The Gemini wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, matching
// the legacy entry).
const parseGeminiModelAction = (modelAction: string | undefined): { model: string; action: string } | Response => {
  if (!modelAction) return geminiRpcErrorResponse(404, 'Missing Gemini model action.');
  const separator = modelAction.lastIndexOf(':');
  if (separator <= 0 || separator === modelAction.length - 1) return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${modelAction}`);
  return { model: modelAction.slice(0, separator).replace(/^models\//, ''), action: modelAction.slice(separator + 1) };
};

// `:countTokens` can carry either `contents` directly or a nested
// `generateContentRequest` envelope (Google's SDK shape). Normalize both to a
// single `GeminiPayload` for the rest of the chain.
const parseGeminiCountTokensPayload = (body: unknown): GeminiPayload => {
  const shape = (body ?? {}) as { contents?: GeminiContent[]; generateContentRequest?: GeminiPayload };
  return shape.generateContentRequest ?? { contents: shape.contents };
};

// Single Hono handler that fans the `/v1beta/models/:modelAction` route into
// the three Gemini sub-endpoints by inspecting the parsed action. Mirrors the
// legacy switch in `routes.ts`/`traits.ts` but lives next to the Gemini code
// it dispatches to.
export const geminiHttp = {
  generate: async (c: Context): Promise<Response> => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    const { model, action } = parsed;
    const wantsStream = action === 'streamGenerateContent';
    const payload = await parseGeminiBody(c, payload => payload as GeminiPayload);
    if (payload instanceof Response) return payload;

    const ctx = createGatewayCtxFromHono(c, wantsStream);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    const result = await geminiServe.generate({ payload, ctx, store, model });
    const { response } = await respondGemini(c, result, wantsStream, ctx);
    return response;
  },

  countTokens: async (c: Context): Promise<Response> => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    const { model } = parsed;
    const payload = await parseGeminiBody(c, parseGeminiCountTokensPayload);
    if (payload instanceof Response) return payload;

    const ctx = createGatewayCtxFromHono(c, false);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    const result = await geminiServe.countTokens({ payload, ctx, store, model });
    const { response } = await respondGemini(c, result, false, ctx);
    return response;
  },

  // Entry-point selector — the Hono route binds to a single
  // `/v1beta/models/:modelAction{.+}` glob, then this dispatches to the right
  // sub-endpoint by suffix. Unknown actions are reported as Google-RPC 404.
  dispatch: async (c: Context): Promise<Response> => {
    const modelAction = c.req.param('modelAction');
    const action = lastActionSegment(modelAction);
    if (action === 'countTokens') return await geminiHttp.countTokens(c);
    if (action === 'generateContent' || action === 'streamGenerateContent') return await geminiHttp.generate(c);
    return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${action ?? modelAction ?? ''}`);
  },
};

const lastActionSegment = (modelAction: string | undefined): string | null => {
  if (!modelAction) return null;
  const colon = modelAction.lastIndexOf(':');
  if (colon <= 0 || colon === modelAction.length - 1) return null;
  return modelAction.slice(colon + 1);
};

// Body-parsing wrapper that lets each endpoint shape its own destructuring
// over the raw JSON while sharing the same Google-RPC 500 error envelope on
// parse failure.
const parseGeminiBody = async <T>(c: Context, project: (body: unknown) => T): Promise<T | Response> => {
  try {
    const raw = await c.req.json<unknown>();
    return project(raw);
  } catch (error) {
    return geminiInternalRpcErrorResponse(500, error);
  }
};
