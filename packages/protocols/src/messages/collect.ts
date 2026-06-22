import type { MessagesResult, MessagesStreamEvent } from './index.ts';
import { reassembleMessagesEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// Folds a recorded `DumpStreamEvent[]` back into a non-streaming
// `MessagesResult` by handing the stored ProtocolFrames straight to the
// same `reassembleMessagesEvents` reducer the gateway runs against a live
// upstream. `truncated` reports whether the captured stream ever reached a
// terminal frame; `error` is set when the stream ended with an `error`
// event (the reassembler folds best-effort either way).
export const collectMessagesStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<MessagesResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<MessagesStreamEvent>;
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'message_stop') { truncated = false; break; }
    if (frame.event.type === 'error') {
      error = frame.event.error.message;
      break;
    }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<MessagesStreamEvent>;
      // Skip error frames so the reassembler doesn't throw — we already
      // captured the message in `error` above and want the best-effort
      // partial fold.
      if (frame.type === 'event' && frame.event.type !== 'error') yield frame.event;
    }
  })();
  try {
    const result = await reassembleMessagesEvents(eventStream);
    return { result, error, truncated, warnings: [] };
  } catch (e) {
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true, warnings: [] };
  }
};
