import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { GeminiPayload, GeminiStreamEvent } from '@floway-dev/protocols/gemini';

export const translateGeminiViaChatCompletions: TranslateTrip<
  GeminiPayload, GeminiStreamEvent, ChatCompletionsPayload, ChatCompletionsStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model),
  events: translateToSourceEvents,
});
