import {
  collectChatCompletionsStream,
  collectGeminiStream,
  collectMessagesStream,
  collectResponsesStream,
} from '@floway-dev/protocols/dump-collect';
import type { DumpStreamEvent } from '@floway-dev/protocols/dump';

// Structured collected view of a streaming response. `result` is the
// fully-reconstructed non-streaming payload (envelope + content blocks +
// tool calls + usage + finish reason etc.) that the dashboard pretty-prints
// as JSON. `error` and `truncated` flag the cases where the stream did not
// close cleanly — the heavy folding logic lives behind
// `@floway-dev/protocols/dump-collect` so the gateway and the dashboard share
// it.
export interface CollectOutcome {
  result: unknown | null;
  error: string | null;
  truncated: boolean;
}

export type CollectKind = 'messages' | 'chat-completions' | 'responses' | 'gemini' | null;

// Sniff the protocol from the request path. The dashboard only renders one
// collected view at a time and the path is the highest-signal hint we have.
export const detectCollectKind = (path: string): CollectKind => {
  if (path.includes('/messages') || path.includes('/v1/messages')) return 'messages';
  if (path.includes('/responses') || path.includes('/v1/responses')) return 'responses';
  if (path.includes('/chat/completions')) return 'chat-completions';
  if (path.includes('/v1beta/') || path.includes(':streamGenerateContent') || path.includes(':generateContent')) return 'gemini';
  return null;
};

export const collectByKind = (kind: CollectKind, events: DumpStreamEvent[]): CollectOutcome => {
  switch (kind) {
  case 'messages': return collectMessagesStream(events);
  case 'chat-completions': return collectChatCompletionsStream(events);
  case 'responses': return collectResponsesStream(events);
  case 'gemini': return collectGeminiStream(events);
  case null: return { result: null, error: null, truncated: false };
  }
};
