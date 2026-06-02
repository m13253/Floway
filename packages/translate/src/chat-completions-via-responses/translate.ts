import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateChatCompletionsViaResponses: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionsStreamEvent, ResponsesPayload, RawResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
