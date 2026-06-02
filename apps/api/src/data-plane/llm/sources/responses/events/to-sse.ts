import { type ProtocolFrame, type SseFrame, sseFrame } from '@floway-dev/protocols/common';
import type { RawResponsesStreamEvent } from '@floway-dev/protocols/responses';

export const responsesProtocolFrameToSSEFrame = (frame: ProtocolFrame<RawResponsesStreamEvent>): SseFrame | null =>
  frame.type === 'event' ? sseFrame(JSON.stringify(frame.event), frame.event.type) : null;
