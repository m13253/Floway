import type { DumpStreamEvent } from '@floway-dev/protocols/dump';

// Cross-protocol collected view of a streaming response. The viewer is the
// only consumer and only needs a permissive "happy-path text + a terminal
// frame snapshot" fold — a spec-complete collector belongs behind
// `translate/` for gateway-side use.
export interface CollectOutcome {
  text: string;
  // null when the terminal frame did not signal an explicit end — usually a
  // dropped/aborted stream. A populated string means "we saw an error frame";
  // the UI can render the verbatim message above the text.
  error: string | null;
  // true when the terminal frame indicated the model returned more than it
  // could emit (length cap, content filter, etc.).
  truncated: boolean;
}

const empty = (): CollectOutcome => ({ text: '', error: null, truncated: false });

const safeParse = (data: string): unknown => {
  try { return JSON.parse(data); } catch { return null; }
};

// Best-effort `get-by-path` over an unknown payload. Returns undefined on any
// hop through a non-object — the callers branch on that.
const get = (obj: unknown, ...path: (string | number)[]): unknown => {
  let cur: unknown = obj;
  for (const seg of path) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string | number, unknown>)[seg];
  }
  return cur;
};

const asString = (v: unknown): string => typeof v === 'string' ? v : '';

// Anthropic Messages — text deltas land in content_block_delta with
// `delta.type === 'text_delta'`; thinking_delta is rendered separately so it
// doesn't bleed into the visible answer. message_delta carries stop_reason.
const collectMessagesStream = (events: DumpStreamEvent[]): CollectOutcome => {
  const out = empty();
  for (const ev of events) {
    const parsed = safeParse(ev.data);
    if (!parsed) continue;
    const type = get(parsed, 'type');
    if (type === 'content_block_delta') {
      const deltaType = get(parsed, 'delta', 'type');
      if (deltaType === 'text_delta') out.text += asString(get(parsed, 'delta', 'text'));
    } else if (type === 'message_delta') {
      const stop = get(parsed, 'delta', 'stop_reason');
      if (stop === 'max_tokens') out.truncated = true;
    } else if (type === 'error') {
      const message = get(parsed, 'error', 'message');
      out.error = typeof message === 'string' ? message : 'stream error';
    }
  }
  return out;
};

// OpenAI Chat Completions — text deltas at choices[0].delta.content, finish
// reason at choices[0].finish_reason on the terminal frame.
const collectChatCompletionsStream = (events: DumpStreamEvent[]): CollectOutcome => {
  const out = empty();
  for (const ev of events) {
    const parsed = safeParse(ev.data);
    if (!parsed) continue;
    const delta = get(parsed, 'choices', 0, 'delta', 'content');
    if (typeof delta === 'string') out.text += delta;
    const finish = get(parsed, 'choices', 0, 'finish_reason');
    if (finish === 'length') out.truncated = true;
    const errMessage = get(parsed, 'error', 'message');
    if (typeof errMessage === 'string') out.error = errMessage;
  }
  return out;
};

// OpenAI Responses — text deltas arrive as response.output_text.delta frames
// with `delta` as a top-level string. response.completed snapshots the full
// output; we prefer the accumulated text if present so we don't lose anything
// the deltas dropped (function-call output blocks, etc.). response.failed /
// response.incomplete are the terminal failure / truncation signals.
const collectResponsesStream = (events: DumpStreamEvent[]): CollectOutcome => {
  const out = empty();
  let snapshot: string | null = null;
  for (const ev of events) {
    const name = ev.event;
    const parsed = safeParse(ev.data);
    if (!parsed) continue;
    if (name === 'response.output_text.delta') {
      const delta = get(parsed, 'delta');
      if (typeof delta === 'string') out.text += delta;
    } else if (name === 'response.completed') {
      const output = get(parsed, 'response', 'output');
      if (Array.isArray(output)) {
        let collected = '';
        for (const item of output) {
          const content = get(item, 'content');
          if (!Array.isArray(content)) continue;
          for (const part of content) {
            if (get(part, 'type') === 'output_text') collected += asString(get(part, 'text'));
          }
        }
        if (collected) snapshot = collected;
      }
    } else if (name === 'response.incomplete') {
      out.truncated = true;
    } else if (name === 'response.failed' || name === 'error') {
      const message = get(parsed, 'response', 'error', 'message') ?? get(parsed, 'error', 'message');
      out.error = typeof message === 'string' ? message : 'stream failed';
    }
  }
  if (snapshot !== null) out.text = snapshot;
  return out;
};

// Google Gemini — streamed chunks at candidates[0].content.parts[].text;
// finishReason on the terminal chunk.
const collectGeminiStream = (events: DumpStreamEvent[]): CollectOutcome => {
  const out = empty();
  for (const ev of events) {
    const parsed = safeParse(ev.data);
    if (!parsed) continue;
    const parts = get(parsed, 'candidates', 0, 'content', 'parts');
    if (Array.isArray(parts)) {
      for (const part of parts) {
        const t = get(part, 'text');
        if (typeof t === 'string') out.text += t;
      }
    }
    const finish = get(parsed, 'candidates', 0, 'finishReason');
    if (finish === 'MAX_TOKENS') out.truncated = true;
    const errMessage = get(parsed, 'error', 'message');
    if (typeof errMessage === 'string') out.error = errMessage;
  }
  return out;
};

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
  case null: return empty();
  }
};
