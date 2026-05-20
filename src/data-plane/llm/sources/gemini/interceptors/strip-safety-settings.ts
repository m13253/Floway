import type { GeminiStreamEvent } from "../../../../shared/protocol/gemini.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { GeminiSourceContext } from "./index.ts";

/**
 * Gemini safety controls are source-specific and have no matching control on
 * every target path. Drop them so we don't pretend to enforce a policy we
 * cannot honor end-to-end.
 */
export const stripSafetySettings: SourceInterceptor<
  GeminiSourceContext,
  GeminiStreamEvent
> = (ctx, run) => {
  delete ctx.payload.safetySettings;
  return run();
};
