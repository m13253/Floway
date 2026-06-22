import { isResponsesTerminalEvent, type ResponsesResult, type ResponsesStreamEvent } from './index.ts';
import { reassembleResponsesEvents } from './reassemble.ts';
import type { ProtocolFrame } from '../common/index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// Folds a recorded `DumpStreamEvent[]` back into a non-streaming
// `ResponsesResult`. Terminal detection reuses the protocol's own
// `isResponsesTerminalEvent`; an `error` or `response.failed` event mid-
// stream is surfaced on `error` while the reassembler still folds.
//
// We call the lower-level `reassembleResponsesEvents` directly instead of
// `collectResponsesProtocolEventsToResult`, because the latter throws on
// missing terminal — that's the right behavior for a live request, but a
// cold dump may genuinely be truncated and we want a best-effort partial.
export const collectResponsesStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<ResponsesResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<ResponsesStreamEvent>;
    if (frame.type !== 'event') continue;
    if (frame.event.type === 'error') {
      error = (frame.event as { message?: string }).message ?? 'stream ended with error event';
      break;
    }
    if (frame.event.type === 'response.failed') {
      error = 'stream ended with response.failed event';
      break;
    }
    if (isResponsesTerminalEvent(frame.event)) { truncated = false; break; }
  }

  const eventStream = (async function* () {
    for (const ev of events) {
      const frame = ev.frame as ProtocolFrame<ResponsesStreamEvent>;
      // Skip error frames — we already captured them on `error`; passing
      // them to the reassembler triggers its own throw ("Upstream SSE
      // error: ..."), losing our raw message.
      if (frame.type === 'event' && frame.event.type !== 'error') yield frame.event;
    }
  })();
  try {
    const result = await reassembleResponsesEvents(eventStream);
    return { result, error, truncated, warnings: [] };
  } catch (e) {
    // The reassembler throws RESPONSES_MISSING_TERMINAL_MESSAGE on a
    // missing terminal — for a cold dump that's the truncated case we
    // already detected. Preserve our own detected error/truncated.
    return { result: null, error: error ?? (truncated ? null : (e instanceof Error ? e.message : String(e))), truncated: true, warnings: [] };
  }
};
