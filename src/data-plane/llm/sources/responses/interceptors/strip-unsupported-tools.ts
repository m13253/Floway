import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import type { ResponsesSourceContext } from "./types.ts";

const UNSUPPORTED_RESPONSES_TOOL_TYPES = new Set(["image_generation"]);

const isUnsupportedToolType = (type: unknown): type is string =>
  typeof type === "string" && UNSUPPORTED_RESPONSES_TOOL_TYPES.has(type);

const stripToolChoice = (
  payload: ResponsesPayload,
  removedUnsupportedTool: boolean,
): void => {
  const choice = payload.tool_choice as unknown;

  if (
    choice && typeof choice === "object" &&
    isUnsupportedToolType((choice as { type?: unknown }).type)
  ) {
    delete payload.tool_choice;
    return;
  }

  if (
    removedUnsupportedTool && choice === "required" &&
    (!Array.isArray(payload.tools) || payload.tools.length === 0)
  ) {
    delete payload.tool_choice;
  }
};

/**
 * Public Responses exposes hosted `image_generation`, but Copilot's Responses
 * upstream does not support that server-side tool or its forced `tool_choice`.
 * Strip both at source so native `/responses` and translated fallback paths
 * share the same cleaned request before planning.
 *
 * References:
 * - https://platform.openai.com/docs/guides/tools-image-generation
 * - https://github.com/caozhiyuan/copilot-api/blob/1d21b4aca31f89ad49a0c3bf1a71e3561d445855/src/routes/responses/handler.ts#L167-L184
 */
export const stripUnsupportedToolsFromPayload = (
  payload: ResponsesPayload,
): void => {
  let removedUnsupportedTool = false;

  if (Array.isArray(payload.tools)) {
    const tools = payload.tools.filter((tool) => {
      const type = (tool as unknown as { type?: unknown }).type;
      const unsupported = isUnsupportedToolType(type);
      removedUnsupportedTool ||= unsupported;
      return !unsupported;
    });

    if (tools.length === 0) {
      delete payload.tools;
    } else {
      payload.tools = tools;
    }
  }

  stripToolChoice(payload, removedUnsupportedTool);
};

export const stripUnsupportedTools: SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
> = (ctx, run) => {
  stripUnsupportedToolsFromPayload(ctx.payload);
  return run();
};
