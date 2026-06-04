import type { Context } from 'hono';

import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { geminiServe } from './serve.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono } from '../shared/gateway-ctx.ts';
import type { GeminiContent, GeminiPayload } from '@floway-dev/protocols/gemini';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

// The Gemini wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, as Google
// SDKs send it).
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

const parseGeminiBody = async <T>(c: Context, project: (body: unknown) => T): Promise<T | Response> => {
  try {
    const raw = await c.req.json<unknown>();
    return project(raw);
  } catch (error) {
    return geminiInternalRpcErrorResponse(500, error);
  }
};

// Surfaces a pre-stream throw as a Gemini-RPC envelope. A
// `ProviderModelsUnavailableError` carrying an upstream HTTP body relays
// that body through `respondGemini`'s `upstream-error` path so it gets
// wrapped in the Google-RPC envelope (status, code, message). Other
// failures collapse to the Gemini internal-error envelope.
const respondWithGeminiError = async (
  c: Context,
  error: unknown,
  ctx: ReturnType<typeof createGatewayCtxFromHono>,
  wantsStream: boolean,
): Promise<Response> => {
  if (error instanceof ProviderModelsUnavailableError && error.httpResponse) {
    const { status, headers, body } = error.httpResponse;
    const upstreamErrorResult = {
      type: 'upstream-error' as const,
      status,
      headers: new Headers(headers),
      body: new TextEncoder().encode(body),
    };
    const { response } = await respondGemini(c, upstreamErrorResult, wantsStream, ctx);
    return response;
  }
  return geminiInternalRpcErrorResponse(500, error);
};

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
    try {
      const result = await geminiServe.generate({ payload, ctx, store, model });
      const { response } = await respondGemini(c, result, wantsStream, ctx);
      return response;
    } catch (error) {
      return await respondWithGeminiError(c, error, ctx, wantsStream);
    }
  },

  countTokens: async (c: Context): Promise<Response> => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    const { model } = parsed;
    const payload = await parseGeminiBody(c, parseGeminiCountTokensPayload);
    if (payload instanceof Response) return payload;

    const ctx = createGatewayCtxFromHono(c, false);
    const store = createNonResponsesSourceStore(ctx.apiKeyId);
    try {
      const result = await geminiServe.countTokens({ payload, ctx, store, model });
      const { response } = await respondGemini(c, result, false, ctx);
      return response;
    } catch (error) {
      return await respondWithGeminiError(c, error, ctx, false);
    }
  },

  dispatch: async (c: Context): Promise<Response> => {
    const parsed = parseGeminiModelAction(c.req.param('modelAction'));
    if (parsed instanceof Response) return parsed;
    if (parsed.action === 'countTokens') return await geminiHttp.countTokens(c);
    if (parsed.action === 'generateContent' || parsed.action === 'streamGenerateContent') return await geminiHttp.generate(c);
    return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${parsed.action}`);
  },
};
