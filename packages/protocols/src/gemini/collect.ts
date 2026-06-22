import type { GeminiResult, GeminiStreamEvent } from './index.ts';
import { collectGeminiProtocolEventsToResult, isGeminiErrorEvent, isGeminiTerminalEvent } from './to-result.ts';
import type { ProtocolFrame } from '../common/index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// Folds a recorded `DumpStreamEvent[]` back into a non-streaming
// `GeminiResult`. Gemini's fold logic lives inline in `to-result.ts`;
// `truncated` reports the absence of a terminal frame, `error` surfaces a
// gemini-shaped error event mid-stream.
export const collectGeminiStream = async (events: readonly DumpStreamEvent[]): Promise<CollectOutcome<GeminiResult>> => {
  let truncated = true;
  let error: string | null = null;
  for (const ev of events) {
    const frame = ev.frame as ProtocolFrame<GeminiStreamEvent>;
    if (frame.type === 'done') { truncated = false; break; }
    if (frame.type !== 'event') continue;
    if (isGeminiErrorEvent(frame.event)) {
      error = (frame.event as { error?: { message?: string } }).error?.message ?? 'stream ended with error event';
      break;
    }
    if (isGeminiTerminalEvent(frame.event)) { truncated = false; break; }
  }

  const frameStream = (async function* () {
    for (const ev of events) yield ev.frame as ProtocolFrame<GeminiStreamEvent>;
  })();
  try {
    const result = await collectGeminiProtocolEventsToResult(frameStream);
    return { result, error, truncated, warnings: [] };
  } catch (e) {
    // Gemini's fold throws GEMINI_MISSING_TERMINAL_MESSAGE when no
    // candidate carried a finishReason — for a cold dump that's the
    // truncated case we already detected, so swallow the throw to a null
    // result and keep our own truncated/error signals.
    if (truncated) {
      return { result: null, error, truncated: true, warnings: [] };
    }
    return { result: null, error: error ?? (e instanceof Error ? e.message : String(e)), truncated: true, warnings: [] };
  }
};
