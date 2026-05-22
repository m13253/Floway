import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { TranslateTrip } from '../types.ts';

export const translateChatCompletionsViaMessages: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionChunk, MessagesPayload, MessagesStreamEventData
> = async (src, ctx) => ({
  target: await buildTargetRequest(src, ctx.capabilities),
  events: translateToSourceEvents,
});
