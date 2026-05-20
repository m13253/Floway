import type { Context } from "hono";
import { ModelsFetchError } from "../../../../providers/upstream-model-cache.ts";
import type {
  GeminiContent,
  GeminiGenerateContentRequest,
} from "../../../../shared/protocol/gemini.ts";
import { toInternalDebugError } from "../../../shared/errors/internal-debug-error.ts";
import { stripUnsupportedPartFieldsFromPayload } from "../interceptors/strip-unsupported-part-fields.ts";
import { stripUnsupportedToolsFromPayload } from "../interceptors/strip-unsupported-tools.ts";
import { buildTargetRequest as buildMessagesTargetRequest } from "../../../translate/gemini-via-messages/request.ts";
import { getModelCapabilities } from "../../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../../providers/run.ts";

interface GeminiCountTokensRequest {
  contents?: GeminiContent[];
  generateContentRequest?: GeminiGenerateContentRequest;
}

const geminiStatusForHttpStatus = (status: number): string => {
  switch (status) {
    case 400:
      return "INVALID_ARGUMENT";
    case 401:
      return "UNAUTHENTICATED";
    case 403:
      return "PERMISSION_DENIED";
    case 404:
      return "NOT_FOUND";
    case 429:
      return "RESOURCE_EXHAUSTED";
    case 500:
      return "INTERNAL";
    case 502:
    case 503:
      return "UNAVAILABLE";
    default:
      return "INTERNAL";
  }
};

const geminiError = (status: number, message: string): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  return Response.json({
    error: { code, message, status: geminiStatusForHttpStatus(code) },
  }, { status: code });
};

const geminiInternalError = (status: number, error: unknown): Response => {
  const code = status >= 400 && status <= 599 ? status : 500;
  const debug = toInternalDebugError(error, "gemini");
  return Response.json({
    error: {
      code,
      message: debug.message,
      status: geminiStatusForHttpStatus(code),
      type: debug.type,
      name: debug.name,
      stack: debug.stack,
      cause: debug.cause,
      source_api: debug.source_api,
      target_api: debug.target_api,
    },
  }, { status: code });
};

const countTokensRequestToGenerateContentRequest = (
  request: GeminiCountTokensRequest,
): GeminiGenerateContentRequest =>
  request.generateContentRequest ?? { contents: request.contents };

// count_tokens reuses Gemini source request normalization, but cannot run the
// full streaming source-interceptor pipeline. Apply the same payload mutations
// directly so its translated request shape matches `generateContent`.
const normalizeCountTokensRequest = (
  payload: GeminiGenerateContentRequest,
): void => {
  stripUnsupportedPartFieldsFromPayload(payload);
  stripUnsupportedToolsFromPayload(payload);
  delete payload.safetySettings;
};

const totalTokensFromUpstream = (value: unknown): number | null => {
  if (!value || typeof value !== "object") return null;
  const payload = value as { input_tokens?: unknown; total_tokens?: unknown };
  if (typeof payload.input_tokens === "number") return payload.input_tokens;
  if (typeof payload.total_tokens === "number") return payload.total_tokens;
  return null;
};

export const countGeminiTokens = async (
  c: Context,
  model: string,
): Promise<Response> => {
  try {
    const request = await c.req.json<GeminiCountTokensRequest>();
    const generateContentRequest = countTokensRequestToGenerateContentRequest(
      request,
    );
    normalizeCountTokensRequest(generateContentRequest);

    const { id: modelId, model: resolvedModel } = await resolveModelForRequest(
      model,
    );

    if (!resolvedModel) {
      return geminiError(
        404,
        `Model ${modelId} is not available on any configured upstream.`,
      );
    }

    const response = await runOnModel(
      resolvedModel,
      async (binding) => {
        const capabilities = getModelCapabilities(binding.upstreamModel);
        if (!capabilities.supportsMessagesCountTokens) {
          return skipProvider(geminiError(
            400,
            `Model ${modelId} does not support countTokens.`,
          ));
        }
        const messagesPayload = buildMessagesTargetRequest(
          generateContentRequest,
          modelId,
          false,
          capabilities,
        );
        const { model: _model, ...body } = messagesPayload;
        const { response } = await binding.provider.callMessagesCountTokens(
          binding.upstreamModel,
          body,
        );
        return response;
      },
    );

    if (!response.ok) {
      const body = await response.text();
      return geminiError(
        response.status,
        body || "Upstream token counting request failed.",
      );
    }

    const parsed = await response.json() as unknown;
    const totalTokens = totalTokensFromUpstream(parsed);
    if (totalTokens === null) {
      return geminiInternalError(
        502,
        new Error("Invalid upstream token counting response."),
      );
    }

    return Response.json({ totalTokens });
  } catch (error) {
    if (error instanceof ModelsFetchError) {
      return geminiError(error.status, error.body);
    }

    return geminiInternalError(500, error);
  }
};
