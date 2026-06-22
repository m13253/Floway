import { chatCompletionsErrorPayloadMessage } from './errors.ts';
import type { ChatCompletionsResult, ChatCompletionsStreamEvent } from './index.ts';
import { reassembleChatCompletionsEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// Folds a recorded `DumpStreamEvent[]` back into a non-streaming
// `ChatCompletionsResult`. Truncation is the absence of a terminal `done`
// frame; an error event mid-stream surfaces on `error` while the
// reassembler still folds whatever chunks arrived first.
export const collectChatCompletionsStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<ChatCompletionsResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<ChatCompletionsStreamEvent>;
    if (frame.type === 'done') { truncated = false; break; }
    if (frame.type === 'event') {
      const errorMsg = chatCompletionsErrorPayloadMessage(frame.event);
      if (errorMsg !== null) {
        error = errorMsg;
        break;
      }
    }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<ChatCompletionsStreamEvent>;
      if (frame.type === 'event') yield frame.event;
    }
  })();
  try {
    const result = await reassembleChatCompletionsEvents(eventStream);
    return { result, error, truncated, warnings: [] };
  } catch (e) {
    return { result: null, error: e instanceof Error ? e.message : String(e), truncated: true, warnings: [] };
  }
};
