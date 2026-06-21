import type {
  ResponsesOutputImageGenerationCall,
  ResponsesOutputItem,
  ResponsesOutputWebSearchCall,
  ResponsesResult,
  ResponsesStreamEvent,
} from './index.ts';
import type { DumpStreamEvent } from '../dump/index.ts';
import type { CollectOutcome } from '../dump-collect/index.ts';

const parseEvent = (raw: DumpStreamEvent): ResponsesStreamEvent | null => {
  const data = raw.data.trim();
  if (data.length === 0) return null;
  return JSON.parse(data) as ResponsesStreamEvent;
};

const cloneOutputItem = (item: ResponsesOutputItem): ResponsesOutputItem => {
  if (item.type === 'message') {
    return { ...item, content: item.content.map(part => ({ ...part })) };
  }
  if (item.type === 'reasoning') {
    return { ...item, summary: item.summary.map(part => ({ ...part })) };
  }
  return { ...item };
};

const setWebSearchStatus = (item: ResponsesOutputItem, status: ResponsesOutputWebSearchCall['status']): ResponsesOutputItem => {
  if (item.type !== 'web_search_call') return item;
  return { ...item, status };
};

const setImageGenStatus = (item: ResponsesOutputItem, status: ResponsesOutputImageGenerationCall['status']): ResponsesOutputItem => {
  if (item.type !== 'image_generation_call') return item;
  return { ...item, status };
};

export const collectResponsesStream = (events: readonly DumpStreamEvent[]): CollectOutcome<ResponsesResult> => {
  let snapshot: ResponsesResult | null = null;
  const output: ResponsesOutputItem[] = [];
  let terminal: ResponsesResult | null = null;
  let error: string | null = null;

  const updateItem = (index: number, updater: (item: ResponsesOutputItem) => ResponsesOutputItem): void => {
    const current = output[index];
    if (current === undefined) return;
    output[index] = updater(current);
  };

  for (const raw of events) {
    const event = parseEvent(raw);
    if (event === null) continue;

    switch (event.type) {
    case 'response.created':
    case 'response.in_progress':
      snapshot = { ...event.response, output: event.response.output.map(cloneOutputItem) };
      break;
    case 'response.output_item.added':
    case 'response.output_item.done':
      // `.done` carries the authoritative item shape (status, results, etc.);
      // it overrides anything the per-event accumulators built.
      output[event.output_index] = cloneOutputItem(event.item);
      break;
    case 'response.content_part.added':
    case 'response.content_part.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'message') return item;
        const content = item.content.slice();
        content[event.content_index] = { ...event.part };
        return { ...item, content };
      });
      break;
    case 'response.output_text.delta':
      updateItem(event.output_index, item => {
        if (item.type !== 'message') return item;
        const existing = item.content[event.content_index];
        // Don't overwrite a slot whose content type we can't extend.
        if (existing !== undefined && existing.type !== 'output_text') return item;
        const content = item.content.slice();
        content[event.content_index] = { type: 'output_text', text: (existing?.text ?? '') + event.delta };
        return { ...item, content };
      });
      break;
    case 'response.output_text.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'message') return item;
        const content = item.content.slice();
        content[event.content_index] = { type: 'output_text', text: event.text };
        return { ...item, content };
      });
      break;
    case 'response.reasoning_summary_part.added':
    case 'response.reasoning_summary_part.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'reasoning') return item;
        const summary = item.summary.slice();
        summary[event.summary_index] = { ...event.part };
        return { ...item, summary };
      });
      break;
    case 'response.reasoning_summary_text.delta':
      updateItem(event.output_index, item => {
        if (item.type !== 'reasoning') return item;
        const existing = item.summary[event.summary_index];
        if (existing !== undefined && existing.type !== 'summary_text') return item;
        const summary = item.summary.slice();
        summary[event.summary_index] = { type: 'summary_text', text: (existing?.text ?? '') + event.delta };
        return { ...item, summary };
      });
      break;
    case 'response.reasoning_summary_text.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'reasoning') return item;
        const summary = item.summary.slice();
        summary[event.summary_index] = { type: 'summary_text', text: event.text };
        return { ...item, summary };
      });
      break;
    case 'response.function_call_arguments.delta':
      updateItem(event.output_index, item =>
        item.type !== 'function_call' ? item : { ...item, arguments: item.arguments + event.delta });
      break;
    case 'response.function_call_arguments.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'function_call') return item;
        return { ...item, arguments: event.arguments };
      });
      break;
    case 'response.custom_tool_call_input.delta':
      updateItem(event.output_index, item =>
        item.type !== 'custom_tool_call' ? item : { ...item, input: item.input + event.delta });
      break;
    case 'response.custom_tool_call_input.done':
      updateItem(event.output_index, item => {
        if (item.type !== 'custom_tool_call') return item;
        return { ...item, input: event.input };
      });
      break;
    case 'response.web_search_call.in_progress':
      updateItem(event.output_index, item => setWebSearchStatus(item, 'in_progress'));
      break;
    case 'response.web_search_call.searching':
      updateItem(event.output_index, item => setWebSearchStatus(item, 'searching'));
      break;
    case 'response.web_search_call.completed':
      updateItem(event.output_index, item => setWebSearchStatus(item, 'completed'));
      break;
    case 'response.image_generation_call.in_progress':
      updateItem(event.output_index, item => setImageGenStatus(item, 'in_progress'));
      break;
    case 'response.image_generation_call.generating':
      updateItem(event.output_index, item => setImageGenStatus(item, 'generating'));
      break;
    case 'response.image_generation_call.completed':
      updateItem(event.output_index, item => setImageGenStatus(item, 'completed'));
      break;
    case 'response.image_generation_call.partial_image':
      // Partial-image frames carry the b64 payload directly; native upstream
      // surfaces it on `.completed` via the eventual `.done` item. Stash it
      // on the in-flight item so a truncated stream still exposes what
      // arrived.
      updateItem(event.output_index, item => {
        if (item.type !== 'image_generation_call') return item;
        return { ...item, result: event.partial_image_b64 };
      });
      break;
    case 'response.output_text.annotation.added':
      // Annotations only become first-class on the terminal `output_item.done`
      // payload; accumulating them mid-stream would invent a wire shape no
      // consumer expects.
      break;
    case 'response.completed':
    case 'response.incomplete':
    case 'response.failed':
      terminal = event.response;
      break;
    case 'error':
      error ??= event.message;
      break;
    case 'ping':
      break;
    default:
      break;
    }
  }

  if (terminal !== null && error === null) {
    return {
      result: { ...terminal, output: terminal.output.map(cloneOutputItem) },
      error: null,
      truncated: terminal.status === 'incomplete' || terminal.status === 'failed',
    };
  }

  const envelope = terminal ?? snapshot;
  if (envelope === null) {
    return {
      result: null,
      error: error ?? 'no response.created or terminal event in stream',
      truncated: true,
    };
  }

  return {
    result: { ...envelope, output },
    error,
    truncated: true,
  };
};
