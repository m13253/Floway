import type { DumpStreamEvent } from '@floway-dev/protocols/dump';
import {
  collectChatCompletionsStream,
  type CollectOutcome as ProtocolCollectOutcome,
  collectGeminiStream,
  collectMessagesStream,
  collectResponsesStream,
} from '@floway-dev/protocols/dump-collect';

export type CollectOutcome = ProtocolCollectOutcome<unknown>;

export type CollectKind = 'messages' | 'chat-completions' | 'responses' | 'gemini';

export const detectCollectKind = (path: string): CollectKind | null => {
  if (path.includes('/messages')) return 'messages';
  if (path.includes('/responses')) return 'responses';
  if (path.includes('/chat/completions')) return 'chat-completions';
  if (path.includes('/v1beta/') || path.includes(':generateContent')) return 'gemini';
  return null;
};

export const collectByKind = (kind: CollectKind, events: DumpStreamEvent[]): Promise<CollectOutcome> => {
  switch (kind) {
  case 'messages': return collectMessagesStream(events);
  case 'chat-completions': return collectChatCompletionsStream(events);
  case 'responses': return collectResponsesStream(events);
  case 'gemini': return collectGeminiStream(events);
  }
};
