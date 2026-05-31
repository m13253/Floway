import { CHAT_COMPLETIONS_MISSING_DONE_MESSAGE } from './protocol.ts';
import { reassembleChatCompletionChunks } from './reassemble.ts';
import type { ChatCompletionChunk, ChatCompletionResponse } from '@floway-dev/protocols/chat-completions';
import { type ProtocolFrame } from '@floway-dev/protocols/common';

const chatCompletionEventsUntilDone = async function* (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): AsyncGenerator<ChatCompletionChunk> {
  for await (const frame of frames) {
    if (frame.type === 'done') return;
    yield frame.event;
  }

  throw new Error(CHAT_COMPLETIONS_MISSING_DONE_MESSAGE);
};

export const collectChatProtocolEventsToCompletion = async (frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>): Promise<ChatCompletionResponse> => {
  return await reassembleChatCompletionChunks(chatCompletionEventsUntilDone(frames));
};
