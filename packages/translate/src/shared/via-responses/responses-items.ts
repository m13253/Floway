import { messagesReasoningIdFromSignature, responsesReasoningToMessagesBlock } from '../messages-and-responses/reasoning.ts';
import type { ChatReasoningItem, Message as ChatMessage } from '@floway-dev/protocols/chat-completions';
import type { GeminiContent } from '@floway-dev/protocols/gemini';
import type { MessagesAssistantContentBlock, MessagesMessage } from '@floway-dev/protocols/messages';
import type { ResponseInputItem, ResponseInputReasoning } from '@floway-dev/protocols/responses';

export type ResponsesItemMapper = (
  item: ResponseInputItem,
) => ResponseInputItem | null | Promise<ResponseInputItem | null>;

export type ResponsesItemVisitor = (item: ResponseInputItem) => void | Promise<void>;

export interface ResponsesItemsView<TSourceItems, TMappedSourceItems = TSourceItems> {
  visitAsResponsesItems(sourceItems: TSourceItems, visitor: ResponsesItemVisitor): Promise<void>;
  mapAsResponsesItems(sourceItems: TSourceItems, mapper: ResponsesItemMapper): Promise<TMappedSourceItems>;
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
} satisfies ResponsesItemsView<string | readonly ResponseInputItem[], string | ResponseInputItem[]>;

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
} satisfies ResponsesItemsView<readonly MessagesMessage[], MessagesMessage[]>;

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
} satisfies ResponsesItemsView<readonly ChatMessage[], ChatMessage[]>;

export const geminiViaResponsesItemsView = {
  visitAsResponsesItems: async (
    _contents: readonly GeminiContent[],
    _visitor: ResponsesItemVisitor,
  ): Promise<void> => {},
  mapAsResponsesItems: async (
    contents: readonly GeminiContent[],
    _mapper: ResponsesItemMapper,
  ): Promise<GeminiContent[]> => contents.map(content => structuredClone(content)),
} satisfies ResponsesItemsView<readonly GeminiContent[], GeminiContent[]>;

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
