import { geminiInternalRpcErrorResponse, geminiRpcErrorResponse, respondGemini } from './respond.ts';
import { geminiServe } from './serve.ts';
import type { AuthedContext } from '../../../middleware/auth.ts';
import { inboundHeadersForUpstream } from '../../shared/inbound-headers.ts';
import { captureResponseAndFinalize } from '../../shared/respond-observer.ts';
import { createNonResponsesSourceStore } from '../responses/items/store.ts';
import { createGatewayCtxFromHono, readRequestBodyForCapture, type GatewayCtxRequestBody, type GatewayCtx } from '../shared/gateway-ctx.ts';
import type { GeminiContent, GeminiPayload } from '@floway-dev/protocols/gemini';
import { ProviderModelsUnavailableError } from '@floway-dev/provider';

interface GeminiModelAction {
  readonly model: string;
  readonly action: string;
}

// The Gemini wire API encodes both the model id and the action in one path
// segment (e.g. `models/gemini-2.5-pro:streamGenerateContent`). The Hono route
// captures everything after `/v1beta/models/` in a single `modelAction` param;
// we split on the trailing `:` here so each entry sees just the action and
// the resolved model id (with a leading `models/` prefix tolerated, as Google
// SDKs send it).
const parseGeminiModelAction = (modelAction: string | undefined): GeminiModelAction | Response => {
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

const parseGeminiBodyBytes = <T>(requestBody: GatewayCtxRequestBody, project: (body: unknown) => T): T | Response => {
  try {
    const raw = JSON.parse(new TextDecoder().decode(requestBody.bytes)) as unknown;
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
  c: AuthedContext,
  error: unknown,
  ctx: GatewayCtx,
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
    return captureResponseAndFinalize(ctx, response);
  }
  return geminiInternalRpcErrorResponse(500, error);
};

// Single entry for `/v1beta/models/:modelAction`. Splits the model and action
// once, then dispatches to the matching sub-handler. Keeping the parse here
// means the sub-handlers see a validated `(model, action)` pair and never
// need to re-emit "Unknown Gemini model action" on already-validated input.
export const geminiHttp = async (c: AuthedContext): Promise<Response> => {
  const parsed = parseGeminiModelAction(c.req.param('modelAction'));
  if (parsed instanceof Response) return parsed;
  if (parsed.action === 'countTokens') return await runGeminiCountTokens(c, parsed.model);
  if (parsed.action === 'generateContent' || parsed.action === 'streamGenerateContent') {
    return await runGeminiGenerate(c, parsed.model, parsed.action === 'streamGenerateContent');
  }
  return geminiRpcErrorResponse(404, `Unknown Gemini model action: ${parsed.action}`);
};

const runGeminiGenerate = async (c: AuthedContext, model: string, wantsStream: boolean): Promise<Response> => {
  const requestBody = await readRequestBodyForCapture(c);
  const payload = parseGeminiBodyBytes(requestBody, body => body as GeminiPayload);
  if (payload instanceof Response) return payload;

  const ctx = createGatewayCtxFromHono(c, { wantsStream, requestBody });
  const store = createNonResponsesSourceStore(ctx.apiKeyId);
  try {
    const result = await geminiServe.generate({ payload, ctx, store, model, headers: inboundHeadersForUpstream(c) });
    const { response } = await respondGemini(c, result, wantsStream, ctx);
    return captureResponseAndFinalize(ctx, response);
  } catch (error) {
    return await respondWithGeminiError(c, error, ctx, wantsStream);
  }
};

const runGeminiCountTokens = async (c: AuthedContext, model: string): Promise<Response> => {
  const requestBody = await readRequestBodyForCapture(c);
  const payload = parseGeminiBodyBytes(requestBody, parseGeminiCountTokensPayload);
  if (payload instanceof Response) return payload;

  const ctx = createGatewayCtxFromHono(c, { wantsStream: false, requestBody });
  const store = createNonResponsesSourceStore(ctx.apiKeyId);
  try {
    const result = await geminiServe.countTokens({ payload, ctx, store, model, headers: inboundHeadersForUpstream(c) });
    const { response } = await respondGemini(c, result, false, ctx);
    return captureResponseAndFinalize(ctx, response);
  } catch (error) {
    return await respondWithGeminiError(c, error, ctx, false);
  }
};
