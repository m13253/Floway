import type { ResponsesItemsView } from '../responses/items/view.ts';
import type { GeminiContent } from '@floway-dev/protocols/gemini';

// Gemini-as-Responses-items view used by `planGeminiRouting`. Visit-only: the
// Gemini wire format carries no gateway-stored reasoning carriers today (we
// have not run the messages-via-responses interop trick on the Gemini side),
// so the affinity classifier walks contents and finds nothing — yielding the
// degenerate identity case from `classifyResponsesItemAffinity`.
export const geminiViaResponsesItemsView: ResponsesItemsView<readonly GeminiContent[]> = {
  visitAsResponsesItems: async () => {},
};
