import type { MessagesStreamEvent } from './index.ts';
import { doneFrame, eventFrame, type ProtocolFrame } from '../common/sse.ts';
import { parseTargetStreamFrames } from '../common/stream/parse-events.ts';
import { parseSSEStream } from '../common/stream/parse-sse.ts';

export interface ParseMessagesStreamOptions {
  signal?: AbortSignal;
}

// Wire→typed pipeline for the Messages SSE protocol. Each provider's
// `callMessages` hands its `Response.body` to this helper to get back the
// decoded `ProtocolFrame<MessagesStreamEvent>` stream that interceptors and
// the target boundary consume.
export const parseMessagesStream = (
  body: ReadableStream<Uint8Array>,
  options: ParseMessagesStreamOptions = {},
): AsyncGenerator<ProtocolFrame<MessagesStreamEvent>> => (async function* () {
  for await (const frame of parseTargetStreamFrames<MessagesStreamEvent>(parseSSEStream(body, options), {
    protocol: 'Messages',
    malformedJsonEventName: 'message',
  })) {
    if (frame.type === 'done') {
      yield doneFrame();
    } else {
      yield eventFrame(frame.data);
    }
  }
})();
