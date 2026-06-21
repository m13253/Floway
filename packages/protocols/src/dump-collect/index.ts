// Per-protocol stream collectors fold a recorded `DumpStreamEvent[]` back into
// the underlying non-streaming result shape. Because the Request Dump feature
// exists to inspect BROKEN streams (truncated mid-flight, ended with an
// upstream error frame, missing the terminal envelope), each collector returns
// a `CollectOutcome` envelope instead of the bare result:
//
//   - happy path:           result populated, error null, truncated false
//   - truncated:            result populated (best-effort), error null,
//                           truncated true
//   - mid-stream error:     result populated (best-effort), error set to the
//                           upstream message, truncated true
//   - catastrophic:         result null, error set, truncated true (e.g. no
//                           envelope frame at all so nothing to fall back on)

export interface CollectOutcome<TResult> {
  result: TResult | null;
  error: string | null;
  truncated: boolean;
}

export { collectMessagesStream } from '../messages/collect.ts';
export { collectResponsesStream } from '../responses/collect.ts';
export { collectChatCompletionsStream } from '../chat-completions/collect.ts';
export { collectGeminiStream } from '../gemini/collect.ts';
