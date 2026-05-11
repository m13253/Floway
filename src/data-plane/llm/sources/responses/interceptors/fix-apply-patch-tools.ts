import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import type { ResponsesSourceContext } from "./types.ts";

/**
 * Public Responses supports both function tools and custom tools, but
 * editor-style `apply_patch` flows are more interoperable when exposed as a
 * function tool with a single `input` string parameter. Codex expects that
 * parameter name, and other Copilot gateways normalize to the same shape.
 *
 * We do this in source so both native `/responses` and translated
 * `/chat/completions -> /responses` traffic share one schema before routing.
 *
 * References:
 * - https://github.com/caozhiyuan/copilot-api/commit/afb7a5c77bdd8a04e57f1c8d210a8659cd28b1f8
 * - https://platform.openai.com/docs/guides/function-calling
 */
const fixPayload = (payload: ResponsesPayload): void => {
  if (!Array.isArray(payload.tools)) return;

  payload.tools = payload.tools.map((tool) =>
    tool.type === "function" || tool.name !== "apply_patch" ? tool : {
      type: "function",
      name: "apply_patch",
      description: "Use the `apply_patch` tool to edit files",
      parameters: {
        type: "object",
        properties: {
          input: {
            type: "string",
            description: "The entire contents of the apply_patch command",
          },
        },
        required: ["input"],
        additionalProperties: false,
      },
      strict: false,
    }
  ) as ResponsesPayload["tools"];
};

export const fixApplyPatchTools: SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
> = (ctx, run) => {
  fixPayload(ctx.payload);
  return run();
};
