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
//
// `warnings` carries per-record diagnostics the collector observed while
// folding but did not promote to the top-level `error` — e.g. an
// `input_json_delta` buffer that truncated mid-token and could not be parsed
// back into the tool_use's typed `input`. The dashboard surfaces them so an
// operator inspecting a broken stream can tell which folded fields are
// honest reconstructions vs. best-effort approximations. Always populated;
// an empty array is the happy-path signal.

export interface CollectOutcome<TResult> {
  result: TResult | null;
  error: string | null;
  truncated: boolean;
  warnings: string[];
}

export { collectMessagesStream } from '../messages/collect.ts';
export { collectResponsesStream } from '../responses/collect.ts';
export { collectChatCompletionsStream } from '../chat-completions/collect.ts';
export { collectGeminiStream } from '../gemini/collect.ts';
