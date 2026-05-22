import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { TranslateTrip } from '../types.ts';

export const translateGeminiViaMessages: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, MessagesPayload, MessagesStreamEventData
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model, ctx.wantsStream, ctx.capabilities),
  events: translateToSourceEvents,
});
