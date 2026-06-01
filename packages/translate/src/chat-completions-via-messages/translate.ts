import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { ChatCompletionsStreamEvent, ChatCompletionsPayload } from '@floway-dev/protocols/chat-completions';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';

export const translateChatCompletionsViaMessages: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionsStreamEvent, MessagesPayload, MessagesStreamEvent,
  { fallbackMaxOutputTokens?: number }
> = async (src, ctx) => ({
  target: await buildTargetRequest(src, { fallbackMaxOutputTokens: ctx.fallbackMaxOutputTokens }),
  events: translateToSourceEvents,
});
