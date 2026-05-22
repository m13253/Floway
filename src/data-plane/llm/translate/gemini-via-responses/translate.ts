import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { GeminiGenerateContentRequest, GeminiStreamEvent } from '../../../shared/protocol/gemini.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { TranslateTrip } from '../types.ts';

export const translateGeminiViaResponses: TranslateTrip<
  GeminiGenerateContentRequest, GeminiStreamEvent, ResponsesPayload, ResponsesStreamEvent
> = async (src, ctx) => ({
  target: buildTargetRequest(src, ctx.model, ctx.wantsStream),
  events: translateToSourceEvents,
});
