import type {
  ChatCompletionsChoiceNonStreaming,
  ChatCompletionsResult,
  ChatCompletionsStreamEvent,
  ChatCompletionsToolCall,
} from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';

const parseEvent = (raw: DumpStreamEvent): ChatCompletionsStreamEvent | null => {
  const data = raw.data.trim();
  if (data.length === 0 || data === '[DONE]') return null;
  return JSON.parse(data) as ChatCompletionsStreamEvent;
};

interface ToolCallAccumulator {
  id: string | null;
  name: string;
  arguments: string;
}

interface ChoiceAccumulator {
  index: number;
  content: string;
  toolCalls: Map<number, ToolCallAccumulator>;
  finish_reason: ChatCompletionsChoiceNonStreaming['finish_reason'] | null;
}

const getOrCreateChoice = (choices: Map<number, ChoiceAccumulator>, index: number): ChoiceAccumulator => {
  const existing = choices.get(index);
  if (existing) return existing;
  const seeded: ChoiceAccumulator = { index, content: '', toolCalls: new Map(), finish_reason: null };
  choices.set(index, seeded);
  return seeded;
};

const buildToolCalls = (choice: ChoiceAccumulator): ChatCompletionsToolCall[] | undefined => {
  if (choice.toolCalls.size === 0) return undefined;
  const indices = [...choice.toolCalls.keys()].sort((a, b) => a - b);
  return indices.map(i => {
    const acc = choice.toolCalls.get(i)!;
    if (acc.id === null) throw new Error(`collectChatCompletionsStream: tool_call at index ${i} missing id`);
    return {
      id: acc.id,
      type: 'function',
      function: { name: acc.name, arguments: acc.arguments },
    };
  });
};

export const collectChatCompletionsStream = (events: readonly DumpStreamEvent[]): ChatCompletionsResult => {
  let envelope: Pick<ChatCompletionsResult, 'id' | 'object' | 'created' | 'model'> | null = null;
  let usage: ChatCompletionsResult['usage'];
  const choices = new Map<number, ChoiceAccumulator>();

  for (const raw of events) {
    const event = parseEvent(raw);
    if (event === null) continue;

    envelope ??= { id: event.id, object: 'chat.completion', created: event.created, model: event.model };
    if (event.usage) usage = event.usage;

    for (const choice of event.choices) {
      const acc = getOrCreateChoice(choices, choice.index);
      const { delta } = choice;
      if (typeof delta.content === 'string') acc.content += delta.content;
      if (delta.tool_calls) {
        for (const tc of delta.tool_calls) {
          const existing = acc.toolCalls.get(tc.index) ?? { id: null, name: '', arguments: '' };
          if (tc.id !== undefined) existing.id = tc.id;
          if (tc.function?.name !== undefined) existing.name += tc.function.name;
          if (tc.function?.arguments !== undefined) existing.arguments += tc.function.arguments;
          acc.toolCalls.set(tc.index, existing);
        }
      }
      if (choice.finish_reason !== null) acc.finish_reason = choice.finish_reason;
    }
  }

  if (envelope === null) throw new Error('collectChatCompletionsStream: no chunks in stream');

  const finalChoices: ChatCompletionsChoiceNonStreaming[] = [...choices.values()]
    .sort((a, b) => a.index - b.index)
    .map(choice => {
      const toolCalls = buildToolCalls(choice);
      const finishReason = choice.finish_reason ?? 'stop';
      return {
        index: choice.index,
        message: {
          role: 'assistant',
          content: choice.content.length > 0 ? choice.content : null,
          ...(toolCalls ? { tool_calls: toolCalls } : {}),
        },
        finish_reason: finishReason,
      };
    });

  return {
    ...envelope,
    choices: finalChoices,
    ...(usage ? { usage } : {}),
  };
};
