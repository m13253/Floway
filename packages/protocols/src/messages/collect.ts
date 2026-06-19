import type {
  MessagesAssistantContentBlock,
  MessagesContentBlockDeltaEvent,
  MessagesContentBlockStartEvent,
  MessagesMessageDeltaEvent,
  MessagesMessageStartEvent,
  MessagesResult,
  MessagesStreamEvent,
} from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

const parseEvent = (raw: DumpStreamEvent): MessagesStreamEvent | null => {
  const data = raw.data.trim();
  if (data.length === 0) return null;
  return JSON.parse(data) as MessagesStreamEvent;
};

const seedFromMessageStart = (event: MessagesMessageStartEvent): MessagesResult => ({
  ...event.message,
  content: [],
  stop_reason: null,
  stop_sequence: null,
});

const openContentBlock = (event: MessagesContentBlockStartEvent): MessagesAssistantContentBlock => {
  const block = event.content_block;
  switch (block.type) {
  case 'text':
    return { type: 'text', text: block.text, ...(block.citations ? { citations: block.citations } : {}) };
  case 'tool_use':
    return { ...block, input: { ...block.input } };
  case 'thinking':
    return { type: 'thinking', thinking: block.thinking };
  case 'redacted_thinking':
    return { type: 'redacted_thinking', data: block.data };
  default:
    return block;
  }
};

const applyDelta = (block: MessagesAssistantContentBlock, event: MessagesContentBlockDeltaEvent, jsonBuffers: Map<number, string>, index: number): MessagesAssistantContentBlock => {
  const { delta } = event;
  if (delta.type === 'text_delta' && block.type === 'text') {
    const next = { ...block, text: block.text + delta.text };
    if (delta.citations) next.citations = [...(block.citations ?? []), ...delta.citations];
    return next;
  }
  if (delta.type === 'citations_delta' && block.type === 'text') {
    return { ...block, citations: [...(block.citations ?? []), delta.citation] };
  }
  if (delta.type === 'thinking_delta' && block.type === 'thinking') {
    return { ...block, thinking: block.thinking + delta.thinking };
  }
  if (delta.type === 'signature_delta' && block.type === 'thinking') {
    return { ...block, signature: (block.signature ?? '') + delta.signature };
  }
  if (delta.type === 'input_json_delta' && block.type === 'tool_use') {
    jsonBuffers.set(index, (jsonBuffers.get(index) ?? '') + delta.partial_json);
    return block;
  }
  return block;
};

const finalizeJsonBuffer = (block: MessagesAssistantContentBlock, buffered: string | undefined): MessagesAssistantContentBlock => {
  if (block.type !== 'tool_use' || buffered === undefined) return block;
  if (buffered.length === 0) return { ...block, input: {} };
  try {
    return { ...block, input: JSON.parse(buffered) as Record<string, unknown> };
  } catch {
    // A truncated stream can leave the partial_json buffer mid-token. Surface
    // the raw fragment under `_partial_json` so the dashboard can show what
    // actually arrived; `input` stays an empty object so the shape is honest.
    return { ...block, input: { _partial_json: buffered } };
  }
};

export const collectMessagesStream = (events: readonly DumpStreamEvent[]): CollectOutcome<MessagesResult> => {
  let result: MessagesResult | null = null;
  const content: MessagesAssistantContentBlock[] = [];
  const jsonBuffers = new Map<number, string>();
  let error: string | null = null;
  let sawMessageStop = false;

  for (const raw of events) {
    const event = parseEvent(raw);
    if (event === null) continue;

    if (event.type === 'message_start') {
      result = seedFromMessageStart(event);
      continue;
    }

    if (event.type === 'error') {
      // Capture the upstream-reported error verbatim and keep folding so any
      // partial content already streamed before the error is still preserved.
      error ??= event.error.message;
      continue;
    }

    if (result === null) {
      // Child frames before `message_start` (or with `message_start` missing
      // entirely) cannot be folded into an envelope. Record the situation but
      // keep scanning so a later `error` frame is still surfaced.
      error ??= `unexpected '${event.type}' before message_start`;
      continue;
    }

    switch (event.type) {
    case 'content_block_start':
      content[event.index] = openContentBlock(event);
      break;
    case 'content_block_delta': {
      const block = content[event.index];
      if (block === undefined) break;
      content[event.index] = applyDelta(block, event, jsonBuffers, event.index);
      break;
    }
    case 'content_block_stop':
      if (content[event.index] !== undefined) {
        content[event.index] = finalizeJsonBuffer(content[event.index], jsonBuffers.get(event.index));
      }
      jsonBuffers.delete(event.index);
      break;
    case 'message_delta':
      result = applyMessageDelta(result, event);
      break;
    case 'message_stop':
      sawMessageStop = true;
      break;
    default:
      break;
    }
  }

  if (result === null) {
    return { result: null, error: error ?? 'no message_start event in stream', truncated: true };
  }

  // Any tool_use block whose `input_json_delta` buffer was never closed by a
  // `content_block_stop` is still folded so the partial buffer is visible.
  for (const [index, buffered] of jsonBuffers) {
    const block = content[index];
    if (block !== undefined) content[index] = finalizeJsonBuffer(block, buffered);
  }

  const truncated = !sawMessageStop || error !== null;
  return { result: { ...result, content }, error, truncated };
};

const applyMessageDelta = (result: MessagesResult, event: MessagesMessageDeltaEvent): MessagesResult => {
  const next: MessagesResult = { ...result };
  if (event.delta.stop_reason !== undefined) next.stop_reason = event.delta.stop_reason;
  if (event.delta.stop_sequence !== undefined) next.stop_sequence = event.delta.stop_sequence;
  if (event.usage) {
    next.usage = {
      ...result.usage,
      output_tokens: event.usage.output_tokens,
      ...(event.usage.input_tokens !== undefined ? { input_tokens: event.usage.input_tokens } : {}),
      ...(event.usage.cache_creation_input_tokens !== undefined ? { cache_creation_input_tokens: event.usage.cache_creation_input_tokens } : {}),
      ...(event.usage.cache_read_input_tokens !== undefined ? { cache_read_input_tokens: event.usage.cache_read_input_tokens } : {}),
      ...(event.usage.server_tool_use !== undefined ? { server_tool_use: event.usage.server_tool_use } : {}),
    };
  }
  return next;
};
