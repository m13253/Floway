import type { MessagesStreamEventData } from "../../../../shared/protocol/messages.ts";
import type { MessagesPayload } from "../../../../shared/protocol/messages.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import { rewriteContextWindowError } from "./rewrite-context-window-error.ts";
import { stripBillingAttribution } from "./strip-billing-attribution.ts";
import { withMessagesWebSearchShim } from "./web-search-shim.ts";

export interface MessagesSourceContext {
  payload: MessagesPayload;
  apiKeyId?: string;
}

export const messagesSourceInterceptors = [
  stripBillingAttribution,
  rewriteContextWindowError,
] satisfies readonly SourceInterceptor<
  MessagesSourceContext,
  MessagesStreamEventData
>[];

export const messagesWebSearchShimInterceptors = [
  withMessagesWebSearchShim,
] satisfies readonly SourceInterceptor<
  MessagesSourceContext,
  MessagesStreamEventData
>[];
