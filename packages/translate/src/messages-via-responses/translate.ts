import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { TranslateTrip } from '../types.ts';
import type { MessagesPayload, MessagesStreamEvent } from '@floway-dev/protocols/messages';
import type { ResponsesPayload, RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const translateMessagesViaResponses: TranslateTrip<
  MessagesPayload, MessagesStreamEvent, ResponsesPayload, RawResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
