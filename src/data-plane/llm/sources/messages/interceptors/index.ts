import type { MessagesStreamEventData } from "../../../../../lib/messages-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import { rewriteContextWindowError } from "./rewrite-context-window-error.ts";
import { stripBillingAttribution } from "./strip-billing-attribution.ts";
import { stripCacheControlScope } from "./strip-cache-control-scope.ts";
import { stripUnsupportedTools } from "./strip-unsupported-tools.ts";
import type { MessagesSourceContext } from "./types.ts";

export type { MessagesSourceContext };

export const messagesSourceInterceptors = [
  stripUnsupportedTools,
  stripBillingAttribution,
  stripCacheControlScope,
  rewriteContextWindowError,
] satisfies readonly SourceInterceptor<
  MessagesSourceContext,
  MessagesStreamEventData
>[];
