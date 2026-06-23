import type { ChatCompletionsStreamEvent } from './index.ts';
import { type ProtocolFrame, type SseFrame, sseFrame } from '../common/index.ts';

interface ChatCompletionsSseFrameOptions {
  includeUsageChunk: boolean;
}

export const chatCompletionsProtocolFrameToSSEFrame = (frame: ProtocolFrame<ChatCompletionsStreamEvent>, options: ChatCompletionsSseFrameOptions): SseFrame | null => {
  if (frame.type === 'done') return sseFrame('[DONE]');
  if (!options.includeUsageChunk && frame.type === 'event' && Array.isArray(frame.event.choices) && frame.event.choices.length === 0 && frame.event.usage !== undefined) return null;
  return sseFrame(JSON.stringify(frame.event));
};
