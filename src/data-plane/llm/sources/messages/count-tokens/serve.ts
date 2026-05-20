import type { Context } from "hono";
import { ModelsFetchError } from "../../../../providers/upstream-model-cache.ts";
import type { MessagesPayload } from "../../../../shared/protocol/messages.ts";
import { getModelCapabilities } from "../../../../providers/capabilities.ts";
import { resolveModelForRequest } from "../../../../providers/registry.ts";
import { runOnModel, skipProvider } from "../../../../providers/run.ts";

const parseAnthropicBeta = (raw: string | undefined): string[] | undefined => {
  if (!raw) return undefined;
  const values = raw.split(",")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  return values.length > 0 ? values : undefined;
};

const bodyBetaParam = (payload: MessagesPayload): string | undefined => {
  const record = payload as unknown as Record<string, unknown>;
  if (Object.hasOwn(record, "anthropic_beta")) return "anthropic_beta";
  if (Object.hasOwn(record, "betas")) return "betas";
  return undefined;
};

const modelsLoadErrorResponse = (error: ModelsFetchError): Response =>
  new Response(error.body, {
    status: error.status,
    headers: new Headers(error.headers),
  });

export const countTokens = async (c: Context) => {
  try {
    const payload = await c.req.json<MessagesPayload>();
    const rejectedBetaParam = bodyBetaParam(payload);
    if (rejectedBetaParam) {
      return c.json({
        error: {
          type: "invalid_request_error",
          message:
            `${rejectedBetaParam} in the Messages request body is not supported; send Anthropic beta flags with the anthropic-beta HTTP header.`,
          param: rejectedBetaParam,
        },
      }, 400);
    }

    const anthropicBeta = parseAnthropicBeta(c.req.header("anthropic-beta"));
    const { id: modelId, model } = await resolveModelForRequest(payload.model);

    if (!model) {
      return c.json({
        error: {
          type: "invalid_request_error",
          message:
            `No upstream provides model ${modelId}. Configure an upstream that exposes this model in the dashboard.`,
        },
      }, 404);
    }

    const resp = await runOnModel(
      model,
      async (binding) => {
        if (
          !getModelCapabilities(binding.upstreamModel)
            .supportsMessagesCountTokens
        ) {
          return Promise.resolve(skipProvider(c.json({
            error: {
              type: "invalid_request_error",
              message:
                `Model ${modelId} does not support the /messages/count_tokens endpoint.`,
            },
          }, 400)));
        }
        const attemptPayload = structuredClone(payload);
        attemptPayload.model = modelId;
        const { model: _model, ...body } = attemptPayload;
        const { response } = await binding.provider.callMessagesCountTokens(
          binding.upstreamModel,
          body,
          undefined,
          anthropicBeta,
        );
        return response;
      },
    );

    return new Response(resp.body, {
      status: resp.status,
      headers: {
        "content-type": resp.headers.get("content-type") ??
          "application/json",
      },
    });
  } catch (e: unknown) {
    if (e instanceof ModelsFetchError) return modelsLoadErrorResponse(e);

    const msg = e instanceof Error ? e.message : String(e);
    console.error("Error counting tokens:", msg);
    return c.json({
      error: {
        type: "invalid_request_error",
        message: `Failed to count tokens: ${msg}`,
      },
    }, 400);
  }
};
