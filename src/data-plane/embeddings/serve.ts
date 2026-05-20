// POST /v1/embeddings — route embedding requests to the provider that
// declares the requested model and embeddings capability.

import type { Context } from "hono";

import type { BackgroundScheduler } from "../../runtime/background.ts";
import { backgroundSchedulerFromContext } from "../../runtime/background.ts";
import { ModelsFetchError } from "../providers/upstream-model-cache.ts";
import { getModelCapabilities } from "../providers/capabilities.ts";
import { resolveModelForRequest } from "../providers/registry.ts";
import { runOnModel, skipProvider } from "../providers/run.ts";
import {
  type PerformanceTelemetryContext,
  recordPerformanceError,
  recordPerformanceLatency,
  recordRequestPerformanceForApiKey,
  runtimeLocationFromRequest,
} from "../shared/telemetry/performance.ts";
import { recordUsageForApiKey } from "../shared/telemetry/usage.ts";
import type { TokenUsage } from "../../repo/types.ts";

interface EmbeddingsRequestBody {
  model?: unknown;
  input?: unknown;
  [key: string]: unknown;
}

const prepareEmbeddingsRequest = (body: string):
  | { type: "ok"; body: Record<string, unknown>; model: string }
  | { type: "invalid"; message: string } => {
  let request: EmbeddingsRequestBody;

  try {
    const parsed = JSON.parse(body) as unknown;
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return {
        type: "invalid",
        message: "Embeddings request body must be an object.",
      };
    }
    request = parsed as EmbeddingsRequestBody;
  } catch {
    return {
      type: "invalid",
      message: "Embeddings request body must be valid JSON.",
    };
  }

  if (typeof request.model !== "string" || request.model.length === 0) {
    return {
      type: "invalid",
      message: "Embeddings request body must include a model string.",
    };
  }

  return { type: "ok", body: request, model: request.model };
};

const modelsLoadErrorResponse = (error: unknown): Response | null =>
  error instanceof ModelsFetchError
    ? new Response(error.body, {
      status: error.status,
      headers: new Headers(error.headers),
    })
    : null;

const errorMessage = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

const apiErrorResponse = (
  c: Context,
  message: string,
  status: 400 | 404 | 502,
): Response => c.json({ error: { message, type: "api_error" } }, status);

const proxyJsonResponse = (resp: Response): Response =>
  new Response(resp.body, {
    status: resp.status,
    headers: {
      "content-type": resp.headers.get("content-type") ?? "application/json",
    },
  });

const tokenUsageFromEmbeddingsResponse = (
  value: unknown,
): TokenUsage | null => {
  if (!value || typeof value !== "object") return null;
  const usage = (value as { usage?: unknown }).usage;
  if (!usage || typeof usage !== "object") return null;
  const promptTokens = (usage as { prompt_tokens?: unknown }).prompt_tokens;
  if (typeof promptTokens !== "number") return null;
  return {
    inputTokens: promptTokens,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
};

const recordUpstreamPerformance = (
  scheduler: BackgroundScheduler | undefined,
  context: PerformanceTelemetryContext | undefined,
  failed: boolean,
  durationMs: number,
): void => {
  if (!context) return;
  const promise = failed
    ? recordPerformanceError(context, "upstream_success")
    : recordPerformanceLatency(context, "upstream_success", durationMs);
  scheduler ? scheduler(promise) : void promise;
};

export const embeddings = async (c: Context): Promise<Response> => {
  const requestStartedAt = performance.now();
  const apiKeyId = c.get("apiKeyId") as string | undefined;
  const runtimeLocation = runtimeLocationFromRequest(c.req.raw);
  const scheduleBackground = backgroundSchedulerFromContext(c);
  const recordUsage = recordUsageForApiKey(apiKeyId);
  const recordRequestPerformance = recordRequestPerformanceForApiKey(
    apiKeyId,
    scheduleBackground,
  );
  let lastPerformance: PerformanceTelemetryContext | undefined;

  try {
    const request = prepareEmbeddingsRequest(await c.req.text());
    if (request.type === "invalid") {
      return apiErrorResponse(c, request.message, 400);
    }

    const { id: modelId, model } = await resolveModelForRequest(request.model);
    if (!model) {
      return apiErrorResponse(
        c,
        `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`,
        404,
      );
    }

    const resp = await runOnModel(
      model,
      async (binding) => {
        if (!getModelCapabilities(binding.upstreamModel).supportsEmbeddings) {
          return skipProvider(apiErrorResponse(
            c,
            `Model ${modelId} does not support the /embeddings endpoint.`,
            400,
          ));
        }
        const { model: _model, ...body } = request.body;
        const upstreamStartedAt = performance.now();
        const { response, modelKey } = await binding.provider.callEmbeddings(
          binding.upstreamModel,
          body,
        );
        const perfContext: PerformanceTelemetryContext | undefined = apiKeyId
          ? {
            keyId: apiKeyId,
            model: modelId,
            upstream: binding.upstream,
            modelKey,
            sourceApi: "embeddings",
            targetApi: "embeddings",
            stream: false,
            runtimeLocation,
          }
          : undefined;
        if (perfContext) lastPerformance = perfContext;

        if (!response.ok) {
          recordUpstreamPerformance(
            scheduleBackground,
            perfContext,
            true,
            performance.now() - upstreamStartedAt,
          );
          recordRequestPerformance(
            perfContext,
            true,
            performance.now() - requestStartedAt,
          );
          return proxyJsonResponse(response);
        }

        let parsed: unknown;
        try {
          parsed = await response.clone().json() as unknown;
        } catch (error) {
          recordUpstreamPerformance(
            scheduleBackground,
            perfContext,
            true,
            performance.now() - upstreamStartedAt,
          );
          throw error;
        }

        recordUpstreamPerformance(
          scheduleBackground,
          perfContext,
          false,
          performance.now() - upstreamStartedAt,
        );
        const usage = tokenUsageFromEmbeddingsResponse(parsed);
        if (usage) {
          await recordUsage({
            model: modelId,
            upstream: binding.upstream,
            modelKey,
          }, usage);
        }
        recordRequestPerformance(
          perfContext,
          false,
          performance.now() - requestStartedAt,
        );
        return proxyJsonResponse(response);
      },
    );

    return resp;
  } catch (e: unknown) {
    const response = modelsLoadErrorResponse(e);
    if (response) return response;

    recordRequestPerformance(
      lastPerformance,
      true,
      performance.now() - requestStartedAt,
    );
    return apiErrorResponse(c, errorMessage(e), 502);
  }
};
