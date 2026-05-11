import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { SourceResponseStreamEvent } from "../events/protocol.ts";
import { fixApplyPatchTools } from "./fix-apply-patch-tools.ts";
import { stripUnsupportedTools } from "./strip-unsupported-tools.ts";
import type { ResponsesSourceContext } from "./types.ts";

export type { ResponsesSourceContext };

export const responsesSourceInterceptors = [
  stripUnsupportedTools,
  fixApplyPatchTools,
] satisfies readonly SourceInterceptor<
  ResponsesSourceContext,
  SourceResponseStreamEvent
>[];
