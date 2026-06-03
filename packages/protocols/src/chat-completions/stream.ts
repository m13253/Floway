import { chatCompletionsErrorPayloadMessage } from './errors.ts';
import type { ChatCompletionsStreamEvent } from './index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';
import { parseTargetStreamFrames } from '../common/stream/parse-events.ts';
import { parseSSEStream } from '../common/stream/parse-sse.ts';

export interface ParseChatCompletionsStreamOptions {
  signal?: AbortSignal;
}

// Probes for OpenAI-style streamed error payloads on the raw JSON before it is
// committed to the ChatCompletionsStreamEvent shape. Some upstreams report
// mid-stream failures via `{ error: { message, type } }` instead of an HTTP
// failure; bubble that as a thrown Error so the target boundary 502s.
const guardChatCompletionsError = (parsed: unknown): void => {
  const errorMessage = chatCompletionsErrorPayloadMessage(parsed);
  if (errorMessage) {
    throw new Error(`Upstream Chat Completions SSE error: ${errorMessage}`);
  }
};

export const parseChatCompletionsStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseChatCompletionsStreamOptions = {},
): AsyncGenerator<ProtocolFrame<ChatCompletionsStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<ChatCompletionsStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Chat Completions',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
    } else {
      guardChatCompletionsError(frame.data);
      yield eventFrame(frame.data);
    }
  }
})();
