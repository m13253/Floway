import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { TranslateTrip } from '../types.ts';

export const translateGeminiViaChatCompletions: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, ChatCompletionsPayload, ChatCompletionChunk
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model, ctx.wantsStream),
  events: translateToSourceEvents,
});
