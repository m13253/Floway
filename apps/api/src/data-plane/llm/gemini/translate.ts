import { stripUnsupportedPartFieldsFromPayload } from './interceptors/strip-unsupported-part-fields.ts';
import { stripUnsupportedToolsFromPayload } from './interceptors/strip-unsupported-tools.ts';
import type { ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { TranslationContext } from '@floway-dev/translate';
import { translateGeminiViaMessages } from '@floway-dev/translate';

// Adapter around `translateGeminiViaMessages` for the countTokens path.
//
// Two adjustments over the generate trip:
//   1. The Gemini count_tokens chain has no event-translation surface (the
//      Messages count_tokens upstream returns a raw `Response`, not an event
//      stream), so the trip's `events` translator is never invoked. We still
//      satisfy the `TranslateTrip` shape so `traverseTranslation` composes;
//      the placeholder iterator surfaces a clear error if anything wires the
//      events branch by mistake.
//   2. The shipped Gemini interceptors that mutate the payload pre-dispatch
//      (`stripUnsupportedPartFields`, `stripUnsupportedTools`,
//      `stripSafetySettings`) and `suppressThoughtParts` cannot run via the
//      countTokens interceptor list — the post-`run()` ones inspect event
//      streams the result type cannot carry — so the payload-mutators are
//      applied inline here on a structuredClone of the source so the
//      caller's payload stays intact.
export const translateGeminiToMessagesForCountTokens = async (
  src: GeminiPayload,
  ctx: TranslationContext<{ fallbackMaxOutputTokens?: number }>,
): Promise<{
  target: MessagesPayload;
  events: (frames: AsyncIterable<ProtocolFrame<MessagesStreamEvent>>) => AsyncIterable<ProtocolFrame<GeminiStreamEvent>>;
}> => {
  const cleaned = structuredClone(src);
  stripUnsupportedPartFieldsFromPayload(cleaned);
  stripUnsupportedToolsFromPayload(cleaned);
  delete cleaned.safetySettings;

  const trip = await translateGeminiViaMessages(cleaned, ctx);
  const { stream: _stream, ...countPayload } = trip.target;
  return {
    target: countPayload,

    async *events() {
      throw new Error('translateGeminiToMessagesForCountTokens: events translator is not used in countTokens path');
    },
  };
};
