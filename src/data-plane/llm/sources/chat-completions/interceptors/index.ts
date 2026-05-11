import type { ChatCompletionChunk } from "../../../../../lib/chat-completions-types.ts";
import type { SourceInterceptor } from "../../run-interceptors.ts";
import type { ChatCompletionsSourceContext } from "./types.ts";

export type { ChatCompletionsSourceContext };

export const chatCompletionsSourceInterceptors = [] satisfies readonly SourceInterceptor<
  ChatCompletionsSourceContext,
  ChatCompletionChunk
>[];
