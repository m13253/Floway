import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import type { GeminiPayload } from '@floway-dev/protocols/gemini';
import type { MessagesPayload } from '@floway-dev/protocols/messages';
import type { TranslationContext } from '@floway-dev/translate';
import { translateGeminiViaMessages } from '@floway-dev/translate';

// Adapter around `translateGeminiViaMessages` for the countTokens path.
//
// The shipped Gemini interceptors that mutate the payload pre-dispatch
// (`stripUnsupportedPartFields`, `stripUnsupportedTools`,
// `stripSafetySettings`) and `suppressThoughtParts` cannot run via the
// countTokens interceptor list — the post-`run()` ones inspect event
// streams the result type cannot carry — so the payload-mutators are
// applied inline here on a structuredClone of the source so the
// caller's payload stays intact.
export const translateGeminiToMessagesForCountTokens = async (
  src: GeminiPayload,
  ctx: TranslationContext<{ fallbackMaxOutputTokens?: number }>,
): Promise<MessagesPayload> => {
  const cleaned = structuredClone(src);
  stripUnsupportedPartFieldsFromPayload(cleaned);
  stripUnsupportedToolsFromPayload(cleaned);
  delete cleaned.safetySettings;

  const trip = await translateGeminiViaMessages(cleaned, ctx);
  const { stream: _stream, ...countPayload } = trip.target;
  return countPayload;
};
