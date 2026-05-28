import { messagesReasoningIdFromSignature, messagesReasoningSignature, responsesReasoningToMessagesBlock } from '../messages-and-responses/reasoning.ts';
import type { ChatCompletionChunk, ChatReasoningItem, Message as ChatMessage } from '@floway-dev/protocols/chat-completions';
import { eventFrame, type ProtocolFrame } from '@floway-dev/protocols/common';
import type { GeminiContent, GeminiStreamEvent } from '@floway-dev/protocols/gemini';
import type { MessagesAssistantContentBlock, MessagesMessage, MessagesStreamEventData } from '@floway-dev/protocols/messages';
import type { ResponseInputItem, ResponsesStreamEvent } from '@floway-dev/protocols/responses';

export type ResponsesItemMapper = (
  item: ResponseInputItem,
) => ResponseInputItem | null | Promise<ResponseInputItem | null>;

export type ResponsesItemVisitor = (item: ResponseInputItem) => void | Promise<void>;

// Stream side splits id-rewrite from persistence. The id rewrite is a sync,
// per-frame transform — every appearance of a Responses item carrier in the
// source stream is fed through `idMapper` and the rewritten id flows out
// without delaying SSE. Persistence sits behind `onItemFinalized`, which is
// awaited only once per upstream id at the protocol-specific "final content"
// frame; by the time the view yields that frame, the row is in the database.
export type ResponsesItemIdMapper = (upstreamId: string, itemType: string) => string;

export type ResponsesItemFinalizedHandler = (
  originalItem: ResponseInputItem,
  newId: string,
) => void | Promise<void>;

// A view onto a source protocol that projects Responses items in and out
// of the source's payload (request) and stream (response).
//
// Payload side: visit (read-only iteration) and map (1-to-1 rewrite or
// 1-to-null drop). The mapper is asymmetric with the stream side because
// payload-side rewrites consume the whole structure at once.
//
// Stream side: id-only rewrite is per-frame and synchronous; the row write
// is per-item and async, fired through `onItemFinalized` at the carrier's
// terminal frame.
export interface ResponsesItemsView<TSourceItems, TMappedSourceItems = TSourceItems, TStreamFrame = unknown> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<TMappedSourceItems>;
  streamMapIdAsResponsesItems(
    frames: AsyncIterable<TStreamFrame>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<TStreamFrame>;
}

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
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ResponsesStreamEvent>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<ResponsesStreamEvent>> {
    // `seenItemTypes` records the item type for every upstream id we have
    // mapped via an item-bearing frame. Delta events only carry `item_id`
    // and no type, so we look the type up here before re-invoking idMapper
    // (idMapper requires a known item type to allocate fresh ids; for
    // cache hits the type is unused but the signature still demands it).
    // A delta referencing an unknown id is upstream protocol corruption
    // and passes through unchanged rather than allocating a phantom row.
    const seenItemTypes = new Map<string, string>();
    const finalized = new Set<string>();

    for await (const frame of frames) {
      if (frame.type !== 'event') {
        yield frame;
        continue;
      }
      const event = frame.event;

      if (event.type === 'response.output_item.added') {
        const upstreamId = itemId(event.item);
        if (upstreamId === null) {
          yield frame;
          continue;
        }
        seenItemTypes.set(upstreamId, event.item.type);
        const newId = idMapper(upstreamId, event.item.type);
        yield eventFrame({ ...event, item: { ...event.item, id: newId } });
        continue;
      }

      if (event.type === 'response.output_item.done') {
        const upstreamId = itemId(event.item);
        if (upstreamId === null) {
          yield frame;
          continue;
        }
        seenItemTypes.set(upstreamId, event.item.type);
        const newId = idMapper(upstreamId, event.item.type);
        if (onItemFinalized && !finalized.has(upstreamId)) {
          finalized.add(upstreamId);
          await onItemFinalized(event.item as unknown as ResponseInputItem, newId);
        }
        yield eventFrame({ ...event, item: { ...event.item, id: newId } });
        continue;
      }

      if (event.type === 'response.completed' || event.type === 'response.incomplete') {
        const output: ResponseInputItem[] = [];
        for (const item of event.response.output) {
          const upstreamId = itemId(item);
          if (upstreamId === null) {
            output.push(item as unknown as ResponseInputItem);
            continue;
          }
          seenItemTypes.set(upstreamId, item.type);
          const newId = idMapper(upstreamId, item.type);
          if (onItemFinalized && !finalized.has(upstreamId)) {
            finalized.add(upstreamId);
            await onItemFinalized(item as unknown as ResponseInputItem, newId);
          }
          output.push({ ...(item as unknown as ResponseInputItem), id: newId });
        }
        yield eventFrame({
          ...event,
          response: { ...event.response, output: output as typeof event.response.output },
        });
        return;
      }

      if (event.type === 'response.failed' || event.type === 'error') {
        yield frame;
        return;
      }

      const refId = (event as { item_id?: unknown }).item_id;
      if (typeof refId === 'string') {
        const knownType = seenItemTypes.get(refId);
        if (knownType === undefined) {
          yield frame;
          continue;
        }
        const newId = idMapper(refId, knownType);
        yield eventFrame({ ...event, item_id: newId } as ResponsesStreamEvent);
        continue;
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

        const mapped = await mapper({
          type: 'reasoning',
          id,
          summary: block.thinking ? [{ type: 'summary_text', text: block.thinking }] : [],
        });
        if (mapped === null) continue;
        const projected = responsesItemToMessagesAssistantBlock(mapped);
        if (projected !== null) content.push(projected);
      }

      out.push({ role: 'assistant', content });
    }
    return out;
  },
  // Messages thinking blocks carry the gateway-encoded Responses reasoning
  // id via signature_delta, which arrives separately from content_block_start
  // and the thinking text deltas. The signature is buffered until
  // content_block_stop so the mapper sees the final accumulated thinking text
  // when reconstructing the virtual reasoning item; mid-block frames stream
  // straight through.
  //
  // Per Anthropic's streaming spec, signature_delta must arrive before
  // content_block_stop for the same block index — see
  // https://platform.claude.com/docs/en/docs/build-with-claude/streaming
  // and the SDKs at anthropics/anthropic-sdk-python and
  // anthropics/anthropic-sdk-typescript. We attack any violation: a stray
  // signature_delta after stop, or a thinking_delta after stop, is treated
  // as upstream protocol corruption and surfaced as a 5xx via plain throw.
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<MessagesStreamEventData>> {
    interface BlockState {
      thinking: string;
      signature?: string;
    }
    const blocks = new Map<number, BlockState>();
    const finalized = new Set<string>();

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
        if (state === undefined) {
          throw new Error(`Messages stream invariant violated: thinking_delta for index ${event.index} arrived without an open thinking block`);
        }
        state.thinking += event.delta.thinking;
        yield frame;
        continue;
      }

      if (event.type === 'content_block_delta' && event.delta.type === 'signature_delta') {
        const state = blocks.get(event.index);
        if (state === undefined) {
          // Either the block isn't a thinking block (no state opened) or
          // it was closed already. Pass through unrewritten; only thinking
          // blocks carry gateway-encoded reasoning ids.
          yield frame;
          continue;
        }
        state.signature = event.delta.signature;
        continue;
      }

      if (event.type === 'content_block_stop') {
        const state = blocks.get(event.index);
        blocks.delete(event.index);
        if (state?.signature !== undefined) {
          const upstreamId = messagesReasoningIdFromSignature(state.signature);
          if (upstreamId === null) {
            // Opaque upstream signature (e.g. Anthropic's native encrypted
            // reasoning) — preserve verbatim so the client can replay it.
            yield eventFrame({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'signature_delta', signature: state.signature },
            });
          } else {
            const newId = idMapper(upstreamId, 'reasoning');
            const originalItem: ResponseInputItem = {
              type: 'reasoning',
              id: upstreamId,
              summary: state.thinking ? [{ type: 'summary_text', text: state.thinking }] : [],
            };
            if (onItemFinalized && !finalized.has(upstreamId)) {
              finalized.add(upstreamId);
              await onItemFinalized(originalItem, newId);
            }
            yield eventFrame({
              type: 'content_block_delta',
              index: event.index,
              delta: { type: 'signature_delta', signature: messagesReasoningSignature(newId) },
            });
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
  // Native Chat upstreams emit `reasoning_items` exactly once per item, in
  // the chunk carrying the output_item.done analogue, with the full summary
  // text. We treat each appearance as the finalizing one and dedupe via the
  // `finalized` set, so a misbehaving upstream that streams the same id
  // across chunks still produces a single row (first chunk's content wins —
  // accepted limitation; native upstreams don't hit this path).
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<ChatCompletionChunk>>,
    idMapper: ResponsesItemIdMapper,
    onItemFinalized?: ResponsesItemFinalizedHandler,
  ): AsyncGenerator<ProtocolFrame<ChatCompletionChunk>> {
    const finalized = new Set<string>();

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
          const newId = idMapper(item.id, 'reasoning');
          if (onItemFinalized && !finalized.has(item.id)) {
            finalized.add(item.id);
            await onItemFinalized(
              { type: 'reasoning', id: item.id, summary: item.summary ?? [] },
              newId,
            );
          }
          mutated = true;
          out.push({ type: 'reasoning', id: newId, summary: item.summary });
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

// Placeholder view. Gemini does not yet have a reasoning-id / signature
// carrier in its protocol, so there is nothing to project. The empty
// implementations let `gemini/serve.ts` go through the uniform stored-items
// ceremony without branching on protocol; when Gemini gains signature
// support, fill these in and the rest of the pipeline keeps working.
export const geminiViaResponsesItemsView = {
  visitAsResponsesItems: async (
    _contents: readonly GeminiContent[],
    _visitor: ResponsesItemVisitor,
  ): Promise<void> => {},
  mapAsResponsesItems: async (
    contents: readonly GeminiContent[],
    _mapper: ResponsesItemMapper,
  ): Promise<GeminiContent[]> => contents.map(content => structuredClone(content)),
  async *streamMapIdAsResponsesItems(
    frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
    _idMapper: ResponsesItemIdMapper,
    _onItemFinalized?: ResponsesItemFinalizedHandler,
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

const itemId = (item: { id?: unknown }): string | null => {
  const id = item.id;
  return typeof id === 'string' && id.length > 0 ? id : null;
};
