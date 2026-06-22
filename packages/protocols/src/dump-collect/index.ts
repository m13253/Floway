// Per-protocol stream collectors fold a recorded `DumpStreamEvent[]` back into
// the non-streaming result shape. Streams may be broken (truncated, ended with
// an upstream error frame, missing the terminal envelope), so the envelope
// reports partial state instead of throwing:
//
//   - happy path:        result populated, error null, truncated false
//   - truncated:         result populated (best-effort), error null, truncated true
//   - mid-stream error:  result populated (best-effort), error set, truncated true
//   - catastrophic:      result null, error set, truncated true
//
// `warnings` is always present (empty array on the happy path) and carries
// per-record folding diagnostics that did not warrant promoting to `error` —
// e.g. an `input_json_delta` buffer that truncated mid-token and could not be
// parsed back into a tool_use's typed `input`.

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
