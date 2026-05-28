import { messagesReasoningIdFromSignature, messagesReasoningSignature, responsesReasoningToMessagesBlock } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionChunk, ChatReasoningItem, Message as ChatMessage } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesAssistantContentBlock, MessagesMessage, MessagesStreamEventData } from '@floway-dev/protocols/messages';
import type { ResponseInputItem, ResponseInputReasoning, ResponseOutputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export type ResponsesItemMapper = (
  item: ResponseInputItem,
) => ResponseInputItem | null | Promise<ResponseInputItem | null>;

export type ResponsesItemVisitor = (item: ResponseInputItem) => void | Promise<void>;

// A view onto a source protocol that projects Responses items in and out
// of the source's payload (request) and stream (response). Both directions
// support 1-to-1 rewrites and 1-to-null drops; arrays / 0-to-N are not
// supported — see ResponsesItemMapper.
export interface ResponsesItemsView<TSourceItems, TMappedSourceItems = TSourceItems, TStreamFrame = unknown> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<TMappedSourceItems>;
  mapStreamAsResponsesItems(frames: AsyncIterable<TStreamFrame>, mapper: ResponsesItemMapper): AsyncGenerator<TStreamFrame>;
}

type ResponsesItemRewrite = { dropped: false; mappedId: string } | { dropped: true };

const trackRewrite = async (
  item: ResponseInputItem,
  mapper: ResponsesItemMapper,
  rewrites: Map<string, ResponsesItemRewrite>,
): Promise<ResponseInputItem | null> => {
  const upstreamId = (item as { id?: unknown }).id;
  if (typeof upstreamId !== 'string' || upstreamId.length === 0) return await mapper(item);

  const existing = rewrites.get(upstreamId);
  if (existing?.dropped) return null;

  const mapped = await mapper(item);
  if (mapped === null) {
    rewrites.set(upstreamId, { dropped: true });
    return null;
  }
  const mappedId = (mapped as { id?: unknown }).id;
  if (typeof mappedId === 'string' && mappedId.length > 0) {
    rewrites.set(upstreamId, { dropped: false, mappedId });
  }
  return mapped;
};

export const responsesItemsView = {
  visitAsResponsesItems: async (
    input: string | readonly ResponseInputItem[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    if (typeof input === 'string') return;
    for (const item of input) await visitor(item);
  },
  mapAsResponsesItems: async (
    input: string | readonly ResponseInputItem[],
    mapper: ResponsesItemMapper,
  ): Promise<string | ResponseInputItem[]> => {
    if (typeof input === 'string') return input;

    const out: ResponseInputItem[] = [];
    for (const item of input) {
      const mapped = await mapper(item);
      if (mapped !== null) out.push(mapped);
    }
    return out;
  },
  async *mapStreamAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
    mapper: ResponsesItemMapper,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    const rewrites = new Map<string, ResponsesItemRewrite>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;

      if (event.type === 'response.output_item.added' || event.type === 'response.output_item.done') {
        const mapped = await trackRewrite(event.item as ResponseInputItem, mapper, rewrites);
        if (mapped === null) continue;
        yield eventFrame({ ...event, item: mapped as ResponseOutputItem });
        continue;
      }

      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const output: ResponseOutputItem[] = [];
        for (const item of event.response.output) {
          const mapped = await trackRewrite(item as ResponseInputItem, mapper, rewrites);
          if (mapped !== null) output.push(mapped as ResponseOutputItem);
        }
        yield eventFrame({
          ...event,
          response: { ...event.response, output },
        });
        return;
      }

      if (event.type === 'response.failed' || event.type === 'error') {
        yield frame;
        return;
      }

      const itemId = (event as { item_id?: unknown }).item_id;
      if (typeof itemId === 'string') {
        const rewrite = rewrites.get(itemId);
        if (rewrite?.dropped) continue;
        if (rewrite !== undefined) {
          yield eventFrame({ ...event, item_id: rewrite.mappedId } as ResponsesStreamEvent);
          continue;
        }
      }
      yield frame;
    }
  },
} satisfies ResponsesItemsView<string | readonly ResponseInputItem[], string | ResponseInputItem[], ProtocolFrame<ResponsesStreamEvent>>;

export const messagesViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;

      for (const block of message.content) {
        if (block.type !== 'thinking') continue;

        const id = messagesReasoningIdFromSignature(block.signature);
        if (id === null) continue;

        await visitor({
          type: 'reasoning',
          id,
          summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
        });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly MessagesMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<MessagesMessage[]> => {
    const out: MessagesMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !Array.isArray(message.content)) {
        out.push(structuredClone(message));
        continue;
      }

      const content: MessagesAssistantContentBlock[] = [];
      for (const block of message.content) {
        if (block.type !== 'thinking') {
          content.push(structuredClone(block));
          continue;
        }

        const id = messagesReasoningIdFromSignature(block.signature);
        if (id === null) {
          content.push(structuredClone(block));
          continue;
        }

        const reasoning: ResponseInputReasoning = {
          type: 'reasoning',
          id,
          summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
        };
        const mapped = await mapper(reasoning);
        if (mapped === null) continue;
        const projected = responsesItemToMessagesAssistantBlock(mapped);
        if (projected !== null) content.push(projected);
      }

      out.push({ role: 'assistant', content });
    }
    return out;
  },
  // Messages thinking blocks carry the gateway-encoded Responses reasoning
  // id via signature_delta, which arrives separately from the block start
  // and the thinking text deltas. We buffer the signature until content_block_stop
  // so the mapper sees the final accumulated thinking summary; mid-block
  // frames stream straight through.
  //
  // 1-to-null degrades to "strip the signature carrier": the visible thinking
  // text has already been yielded and cannot be retroactively suppressed
  // without buffering the whole block. Callers that need full suppression
  // must drop the item before viaTranslation back-translates it into a
  // Messages thinking block.
  async *mapStreamAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
    mapper: ResponsesItemMapper,
  ): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    interface BlockState {
      thinking: string;
      signature?: string;
    }
    const blocks = new Map<number, BlockState>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;

      if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        blocks.set(event.index, { thinking: event.content_block.thinking });
        yield frame;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'thinking_delta') {
        const state = blocks.get(event.index);
        if (state !== undefined) state.thinking += event.delta.thinking;
        yield frame;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'signature_delta') {
        const state = blocks.get(event.index);
        if (state !== undefined) {
          state.signature = event.delta.signature;
          continue;
        }
        yield frame;
        continue;
      }

      if (event.type === 'content_block_stop') {
        const state = blocks.get(event.index);
        blocks.delete(event.index);
        if (state?.signature !== undefined) {
          const upstreamId = messagesReasoningIdFromSignature(state.signature);
          if (upstreamId === null) {
            yield eventFrame({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'signature_delta', signature: state.signature },
            });
          } else {
            const mapped = await mapper({
              type: 'reasoning',
              id: upstreamId,
              summary: state.thinking ? [{ type: 'summary_text', text: state.thinking }] : [],
            });
            if (mapped !== null) {
              if (mapped.type !== 'reasoning') {
                throw new Error(`Cannot project Responses ${mapped.type} item into a Messages thinking signature`);
              }
              yield eventFrame({
                type: 'content_block_delta',
                index: event.index,
                delta: { type: 'signature_delta', signature: messagesReasoningSignature(mapped.id) },
              });
            }
          }
        }
        yield frame;
        continue;
      }

      yield frame;
    }
  },
} satisfies ResponsesItemsView<readonly MessagesMessage[], MessagesMessage[], ProtocolFrame<MessagesStreamEventData>>;

export const chatCompletionsViaResponsesItemsView = {
  visitAsResponsesItems: async (
    messages: readonly ChatMessage[],
    visitor: ResponsesItemVisitor,
  ): Promise<void> => {
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) continue;

      for (const item of message.reasoning_items) {
        if (!item.id) continue;
        await visitor({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
      }
    }
  },
  mapAsResponsesItems: async (
    messages: readonly ChatMessage[],
    mapper: ResponsesItemMapper,
  ): Promise<ChatMessage[]> => {
    const out: ChatMessage[] = [];
    for (const message of messages) {
      if (message.role !== 'assistant' || !message.reasoning_items?.length) {
        out.push(structuredClone(message));
        continue;
      }

      const reasoningItems: ChatReasoningItem[] = [];
      for (const item of message.reasoning_items) {
        if (!item.id) {
          reasoningItems.push(structuredClone(item));
          continue;
        }
        const mapped = await mapper({ type: 'reasoning', id: item.id, summary: item.summary ?? [] });
        if (mapped === null) continue;
        if (mapped.type !== 'reasoning') throw new Error(`Cannot project Responses ${mapped.type} item into Chat reasoning_items`);
        reasoningItems.push({ type: 'reasoning', id: mapped.id, summary: mapped.summary });
      }

      out.push({
        ...structuredClone(message),
        reasoning_items: reasoningItems.length > 0 ? reasoningItems : null,
      });
    }
    return out;
  },
  // Chat reasoning items appear inside `choices[].delta.reasoning_items`,
  // possibly across multiple chunks for the same upstream id with growing
  // summary text. We call the mapper for every appearance so the wrap's
  // mapper can upsert candidate rows with the latest summary content;
  // returning null in any chunk marks the upstream id as dropped and
  // subsequent appearances are filtered out.
  async *mapStreamAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
    mapper: ResponsesItemMapper,
  ): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
    const rewrites = new Map<string, ResponsesItemRewrite>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const chunk = frame.event;
      let mutated = false;
      const choices = await Promise.all(chunk.choices.map(async choice => {
        const reasoningItems = choice.delta.reasoning_items;
        if (!reasoningItems?.length) return choice;

        const out: ChatReasoningItem[] = [];
        for (const item of reasoningItems) {
          if (!item.id) {
            out.push(item);
            continue;
          }
          const mapped = await trackRewrite(
            { type: 'reasoning', id: item.id, summary: item.summary ?? [] },
            mapper,
            rewrites,
          );
          if (mapped === null) {
            mutated = true;
            continue;
          }
          if (mapped.type !== 'reasoning') throw new Error(`Cannot project Responses ${mapped.type} item into Chat reasoning_items`);
          if (mapped.id !== item.id || mapped.summary !== item.summary) mutated = true;
          out.push({ type: 'reasoning', id: mapped.id, summary: mapped.summary });
        }

        if (!mutated) return choice;
        return {
          ...choice,
          delta: { ...choice.delta, reasoning_items: out.length > 0 ? out : null },
        };
      }));

      if (!mutated) {
        yield frame;
        continue;
      }
      yield eventFrame({ ...chunk, choices });
    }
  },
} satisfies ResponsesItemsView<readonly ChatMessage[], ChatMessage[], ProtocolFrame<ChatCompletionChunk>>;

export const geminiViaResponsesItemsView = {
  visitAsResponsesItems: async (
    _contents: readonly GeminiContent[],
    _visitor: ResponsesItemVisitor,
  ): Promise<void> => {},
  mapAsResponsesItems: async (
    contents: readonly GeminiContent[],
    _mapper: ResponsesItemMapper,
  ): Promise<GeminiContent[]> => contents.map(content => structuredClone(content)),
  async *mapStreamAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
    _mapper: ResponsesItemMapper,
  ): AsyncGenerator<ProtocolFrame<GeminiStreamEvent>> {
    for await (const frame of frames) yield frame;
  },
} satisfies ResponsesItemsView<readonly GeminiContent[], GeminiContent[], ProtocolFrame<GeminiStreamEvent>>;

const responsesItemToMessagesAssistantBlock = (item: ResponseInputItem): MessagesAssistantContentBlock | null => {
  switch (item.type) {
  case 'reasoning':
    return responsesReasoningToMessagesBlock(item);
  case 'message': {
    if (item.role !== 'assistant') return null;
    const text = responseMessageOutputText(item);
    return text ? { type: 'text', text } : null;
  }
  case 'function_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: parseToolInput(item.arguments) };
  case 'custom_tool_call':
    return { type: 'tool_use', id: item.call_id, name: item.name, input: { input: item.input } };
  default:
    throw new Error(`Cannot project Responses ${item.type} item into a Messages assistant content block`);
  }
};

const responseMessageOutputText = (item: Extract<ResponseInputItem, { type: 'message' }>): string => {
  if (typeof item.content === 'string') return item.content;
  return item.content
    .filter((part): part is Extract<typeof part, { text: string }> => 'text' in part)
    .map(part => part.text)
    .join('');
};

const parseToolInput = (argumentsJson: string): Record<string, unknown> => {
  try {
    const parsed = JSON.parse(argumentsJson) as unknown;
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed as Record<string, unknown> : {};
  } catch {
    return {};
  }
};
