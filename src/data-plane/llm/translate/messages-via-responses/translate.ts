import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { MessagesPayload, MessagesStreamEventData } from '../../../shared/protocol/messages.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { TranslateTrip } from '../types.ts';

export const translateMessagesViaResponses: TranslateTrip<
  MessagesPayload, MessagesStreamEventData, ResponsesPayload, ResponsesStreamEvent
> = async src => ({
  target: buildTargetRequest(src),
  events: translateToSourceEvents,
});
