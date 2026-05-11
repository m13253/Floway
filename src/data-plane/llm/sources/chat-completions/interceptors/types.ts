import type { ChatCompletionsPayload } from "../../../../../lib/chat-completions-types.ts";

export interface ChatCompletionsSourceContext {
  payload: ChatCompletionsPayload;
  apiKeyId?: string;
}
