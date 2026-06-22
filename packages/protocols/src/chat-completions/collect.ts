import type {
  ChatCompletionsChoiceNonStreaming,
  ChatCompletionsResult,
  ChatCompletionsStreamEvent,
  ChatCompletionsToolCall,
} from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

// OpenAI Chat Completions SSE has no dedicated error event type — upstream
// errors land as an ordinary `data:` JSON whose body lacks `choices` and
// instead carries `{ error: { message, code, ... } }`. Detect that shape
// before attempting to fold the chunk as a normal event.
interface ChatCompletionsErrorChunk {
  error: { message: string; code?: string; type?: string };
}

const isErrorChunk = (parsed: unknown): parsed is ChatCompletionsErrorChunk => {
  if (typeof parsed !== 'object' || parsed === null) return false;
  if (!('error' in parsed)) return false;
  const err = (parsed as { error: unknown }).error;
  if (typeof err !== 'object' || err === null) return false;
  // Require a string `message` so a legitimate result that happens to carry
  // an `error` extension key isn't misclassified.
  return 'message' in err && typeof (err as { message: unknown }).message === 'string';
};

type ParsedChunk =
  | { kind: 'event'; event: ChatCompletionsStreamEvent }
  | { kind: 'error'; message: string }
  | { kind: 'done' }
  | { kind: 'empty' };

const parseChunk = (raw: DumpStreamEvent): ParsedChunk => {
  const data = raw.data.trim();
  if (data.length === 0) return { kind: 'empty' };
  if (data === '[DONE]') return { kind: 'done' };
  const parsed = JSON.parse(data) as unknown;
  if (isErrorChunk(parsed)) {
    return { kind: 'error', message: parsed.error.message };
  }
  return { kind: 'event', event: parsed as ChatCompletionsStreamEvent };
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
    // A truncated stream can drop the chunk carrying `id` entirely; surface a
    // placeholder rather than throwing so the partial tool call is still
    // visible. Tool calls that received an id chunk will have set `acc.id` to
    // a real value before reaching here.
    const id = acc.id ?? `__missing_id_${i}__`;
    return {
      id,
      type: 'function',
      function: { name: acc.name, arguments: acc.arguments },
    };
  });
};

export const collectChatCompletionsStream = (events: readonly DumpStreamEvent[]): CollectOutcome<ChatCompletionsResult> => {
  let envelope: Pick<ChatCompletionsResult, 'id' | 'object' | 'created' | 'model'> | null = null;
  let usage: ChatCompletionsResult['usage'];
  const choices = new Map<number, ChoiceAccumulator>();
  let error: string | null = null;
  let sawDone = false;

  for (const raw of events) {
    const parsed = parseChunk(raw);
    if (parsed.kind === 'empty') continue;
    if (parsed.kind === 'done') {
      sawDone = true;
      continue;
    }
    if (parsed.kind === 'error') {
      error ??= parsed.message;
      continue;
    }

    const { event } = parsed;
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

  if (envelope === null) {
    return {
      result: null,
      error: error ?? 'no chunks in stream',
      truncated: true,
      warnings: [],
    };
  }

  // Any choice still missing its `finish_reason` (or, more obviously, the
  // entire stream missing `[DONE]`) is a sign of an interrupted stream.
  const anyChoiceMissingFinish = [...choices.values()].some(c => c.finish_reason === null);
  const truncated = !sawDone || anyChoiceMissingFinish || error !== null;

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
    result: {
      ...envelope,
      choices: finalChoices,
      ...(usage ? { usage } : {}),
    },
    error,
    truncated,
    warnings: [],
  };
};
