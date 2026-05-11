import type { ResponsesPayload } from "../../../../../lib/responses-types.ts";

export interface ResponsesSourceContext {
  payload: ResponsesPayload;
  apiKeyId?: string;
}
