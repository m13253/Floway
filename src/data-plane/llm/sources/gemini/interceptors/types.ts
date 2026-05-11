import type { GeminiGenerateContentRequest } from "../../../../../lib/gemini-types.ts";

export interface GeminiSourceContext {
  payload: GeminiGenerateContentRequest;
  apiKeyId?: string;
}
