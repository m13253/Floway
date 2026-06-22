import type {
  MessagesAssistantContentBlock,
  MessagesContentBlockDeltaEvent,
  MessagesContentBlockStartEvent,
  MessagesMessageDeltaEvent,
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

const openContentBlock = (event: MessagesContentBlockStartEvent): MessagesAssistantContentBlock => {
  const block = event.content_block;
  switch (block.type) {
  case 'text':
    return { type: 'text', text: block.text, ...(block.citations ? { citations: block.citations } : {}) };
  case 'tool_use':
    return { ...block };
  case 'thinking':
    return { type: 'thinking', thinking: block.thinking };
  case 'redacted_thinking':
    return { type: 'redacted_thinking', data: block.data };
  default:
    return block;
  }
};

const applyDelta = (block: MessagesAssistantContentBlock, event: MessagesContentBlockDeltaEvent, jsonBuffers: Map<number, string>): MessagesAssistantContentBlock => {
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
    jsonBuffers.set(event.index, (jsonBuffers.get(event.index) ?? '') + delta.partial_json);
    return block;
  }
  return block;
};

interface JsonBufferOutcome {
  block: MessagesAssistantContentBlock;
  warning: string | null;
}

const finalizeJsonBuffer = (block: MessagesAssistantContentBlock, buffered: string | undefined, index: number): JsonBufferOutcome => {
  if (block.type !== 'tool_use' || buffered === undefined) return { block, warning: null };
  if (buffered.length === 0) return { block: { ...block, input: {} }, warning: null };
  try {
    return { block: { ...block, input: JSON.parse(buffered) as Record<string, unknown> }, warning: null };
  } catch (err) {
    // Truncated stream: return {} so the typed `input` shape stays honest, and surface the raw fragment as a warning.
    const reason = err instanceof Error ? err.message : String(err);
    const preview = buffered.length > 80 ? `${buffered.slice(0, 80)}…` : buffered;
    return {
      block: { ...block, input: {} },
      warning: `content[${index}] tool_use ${block.name} (id=${block.id}): partial_json buffer did not parse (${reason}); raw fragment: ${preview}`,
    };
  }
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

export const collectMessagesStream = (events: readonly DumpStreamEvent[]): CollectOutcome<MessagesResult> => {
  let result: MessagesResult | null = null;
  const content: MessagesAssistantContentBlock[] = [];
  const jsonBuffers = new Map<number, string>();
  const warnings: string[] = [];
  let error: string | null = null;
  let sawMessageStop = false;

  for (const raw of events) {
    const event = parseEvent(raw);
    if (event === null) continue;

    if (event.type === 'message_start') {
      result = { ...event.message };
      continue;
    }

    if (event.type === 'error') {
      // Keep folding after an error frame so any partial content streamed before it is still preserved.
      error ??= event.error.message;
      continue;
    }

    if (result === null) {
      // Keep scanning so a later error frame is still surfaced.
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
      content[event.index] = applyDelta(block, event, jsonBuffers);
      break;
    }
    case 'content_block_stop': {
      const block = content[event.index];
      if (block !== undefined) {
        const finalized = finalizeJsonBuffer(block, jsonBuffers.get(event.index), event.index);
        content[event.index] = finalized.block;
        if (finalized.warning) warnings.push(finalized.warning);
      }
      jsonBuffers.delete(event.index);
      break;
    }
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
    return { result: null, error: error ?? 'no message_start event in stream', truncated: true, warnings };
  }

  // Fold any tool_use buffers left open by a truncated stream so the partial JSON is still visible.
  for (const [index, buffered] of jsonBuffers) {
    const block = content[index];
    if (block !== undefined) {
      const finalized = finalizeJsonBuffer(block, buffered, index);
      content[index] = finalized.block;
      if (finalized.warning) warnings.push(finalized.warning);
    }
  }

  const truncated = !sawMessageStop || error !== null;
  return { result: { ...result, content }, error, truncated, warnings };
};
