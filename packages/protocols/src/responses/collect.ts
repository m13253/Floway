import type {
  ResponsesOutputContentBlock,
  ResponsesOutputItem,
  ResponsesOutputMessage,
  ResponsesResult,
  ResponsesStreamEvent,
} from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';

const parseEvent = (raw: DumpStreamEvent): ResponsesStreamEvent | null => {
  const data = raw.data.trim();
  if (data.length === 0) return null;
  return JSON.parse(data) as ResponsesStreamEvent;
};

const cloneOutputItem = (item: ResponsesOutputItem): ResponsesOutputItem => {
  if (item.type === 'message') {
    return { ...item, content: item.content.map(part => ({ ...part })) };
  }
  return { ...item };
};

const appendOutputText = (item: ResponsesOutputItem, contentIndex: number, delta: string): ResponsesOutputItem => {
  if (item.type !== 'message') return item;
  const content: ResponsesOutputContentBlock[] = item.content.slice();
  const existing = content[contentIndex] ?? { type: 'output_text', text: '' };
  if (existing.type === 'output_text') {
    content[contentIndex] = { type: 'output_text', text: existing.text + delta };
  }
  const next: ResponsesOutputMessage = { ...item, content };
  return next;
};

const seedFromCreated = (response: ResponsesResult): ResponsesResult => ({
  ...response,
  output: response.output.map(cloneOutputItem),
});

export const collectResponsesStream = (events: readonly DumpStreamEvent[]): ResponsesResult => {
  let snapshot: ResponsesResult | null = null;
  const output: ResponsesOutputItem[] = [];

  for (const raw of events) {
    const event = parseEvent(raw);
    if (event === null) continue;

    switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      snapshot = seedFromCreated(event.response);
      break;
    case 'response.output_item.added':
      output[event.output_index] = cloneOutputItem(event.item);
      break;
    case 'response.output_item.done':
      output[event.output_index] = cloneOutputItem(event.item);
      break;
    case 'response.output_text.delta': {
      const current = output[event.output_index];
      if (current) output[event.output_index] = appendOutputText(current, event.content_index, event.delta);
      break;
    }
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      // Terminal frame carries the canonical final `ResponsesResult`. Adopt it
      // outright — its `output` is authoritative over the per-item accumulator.
      return { ...event.response, output: event.response.output.map(cloneOutputItem) };
    default:
      break;
    }
  }

  if (snapshot === null) throw new Error('collectResponsesStream: no response.created or terminal event in stream');
  return { ...snapshot, output };
};
