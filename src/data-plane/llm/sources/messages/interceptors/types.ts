import type { MessagesPayload } from "../../../../../lib/messages-types.ts";

export interface MessagesSourceContext {
  payload: MessagesPayload;
  apiKeyId?: string;
}
