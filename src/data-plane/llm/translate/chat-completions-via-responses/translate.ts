import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { TranslateTrip } from '../types.ts';

export const translateChatCompletionsViaResponses: TranslateTrip<
  ChatCompletionsPayload, ChatCompletionChunk, ResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
