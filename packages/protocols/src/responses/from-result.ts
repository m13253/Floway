import { imageGenerationCallLifecycleEvents } from './image-generation-lifecycle.ts';
import type { ResponseOutputCustomToolCall, ResponseOutputFunctionCall, ResponseOutputImageGenerationCall, ResponseOutputItem, ResponseOutputMessage, ResponseOutputReasoning, ResponseOutputWebSearchCall, ResponsesResult, ResponseStreamEvent, SequencedResponsesStreamEvent } from './index.ts';
import { webSearchCallLifecycleEvents } from './web-search-lifecycle.ts';
import { type EventFrame, eventFrame } from '../common/index.ts';

const getTerminalEventName = (response: ResponsesResult): 'response.failed' | 'response.incomplete' | 'response.in_progress' | 'response.completed' => {
  if (response.status === 'failed') return 'response.failed';
  if (response.status === 'incomplete') return 'response.incomplete';
  if (response.status === 'in_progress') return 'response.in_progress';
  return 'response.completed';
};

const responseStartSnapshot = (response: ResponsesResult): ResponsesResult => {
  const { error: _error, incomplete_details: _incompleteDetails, output: _output, output_text: _outputText, ...snapshot } = response;

  // JSON fallback has no upstream incremental frames, so synthesize the same
  // empty in-progress envelope that a real stream would start with. Emitting
  // terminal output or errors here would duplicate later item/terminal events.
  // `output_text` is not synthesized — it's an SDK-only convenience alias
  // and absent from real upstream wire frames. `error` and
  // `incomplete_details` are required-nullable per the Responses spec; on
  // a success-path in-progress envelope they MUST be present as null.
  return {
    ...snapshot,
    status: 'in_progress',
    output: [],
    error: null,
    incomplete_details: null,
  };
};

// Per-item child events (`response.content_part.*`, `response.output_text.*`,
// `response.function_call_arguments.*`, etc.) carry an `item_id` that real
// upstream streams set to the owning item's real id — the same id that the
// item exposes on `response.output_item.added`/`.done`. The JSON fast path is
// expanded from a terminal upstream result, so its output items already carry
// that id; faithfully reusing it keeps the synthesized stream byte-identical to
// a native one. A carrier that emits child frames therefore has nothing to fall
// back to if its id is missing, so we surface that rather than invent one.
const requireItemId = (item: { type: string; id?: string }): string => {
  if (item.id === undefined) throw new Error(`Responses ${item.type} output item is missing its id`);
  return item.id;
};

const responseMessageEvents = (item: ResponseOutputMessage, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = requireItemId(item);
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'message',
        id: itemId,
        role: 'assistant',
        content: item.content.map(part => (part.type === 'output_text' ? { type: 'output_text', text: '' } : part)),
      },
    },
  ];

  item.content.forEach((part, contentIndex) => {
    if (part.type === 'output_text') {
      events.push({
        type: 'response.content_part.added',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part: { type: 'output_text', text: '' },
      });

      if (part.text.length > 0) {
        events.push({
          type: 'response.output_text.delta',
          item_id: itemId,
          output_index: outputIndex,
          content_index: contentIndex,
          delta: part.text,
        });
      }

      events.push({
        type: 'response.output_text.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        text: part.text,
      });
      events.push({
        type: 'response.content_part.done',
        item_id: itemId,
        output_index: outputIndex,
        content_index: contentIndex,
        part,
      });
      return;
    }

    events.push({
      type: 'response.content_part.added',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
    events.push({
      type: 'response.content_part.done',
      item_id: itemId,
      output_index: outputIndex,
      content_index: contentIndex,
      part,
    });
  });

  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseReasoningEvents = (item: ResponseOutputReasoning, outputIndex: number): ResponseStreamEvent[] => {
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'reasoning',
        id: item.id,
        summary: [],
      },
    },
  ];

  item.summary.forEach((part, summaryIndex) => {
    events.push({
      type: 'response.reasoning_summary_part.added',
      item_id: item.id,
      output_index: outputIndex,
      summary_index: summaryIndex,
      part: { type: 'summary_text', text: '' },
    });

    if (part.text.length > 0) {
      events.push({
        type: 'response.reasoning_summary_text.delta',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        delta: part.text,
      });
      events.push({
        type: 'response.reasoning_summary_text.done',
        item_id: item.id,
        output_index: outputIndex,
        summary_index: summaryIndex,
        text: part.text,
      });
    }

    events.push({
      type: 'response.reasoning_summary_part.done',
      item_id: item.id,
      output_index: outputIndex,
      summary_index: summaryIndex,
      part,
    });
  });

  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseFunctionCallEvents = (item: ResponseOutputFunctionCall, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = requireItemId(item);
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: {
        type: 'function_call',
        id: itemId,
        call_id: item.call_id,
        name: item.name,
        arguments: '',
        status: 'in_progress',
      },
    },
  ];

  if (item.arguments.length > 0) {
    events.push({
      type: 'response.function_call_arguments.delta',
      item_id: itemId,
      output_index: outputIndex,
      delta: item.arguments,
    });
  }

  events.push({
    type: 'response.function_call_arguments.done',
    item_id: itemId,
    output_index: outputIndex,
    arguments: item.arguments,
  });
  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseCustomToolCallEvents = (item: ResponseOutputCustomToolCall, outputIndex: number): ResponseStreamEvent[] => {
  const itemId = requireItemId(item);
  const events: ResponseStreamEvent[] = [
    {
      type: 'response.output_item.added',
      output_index: outputIndex,
      item: { ...item, id: itemId, input: '' },
    },
  ];

  if (item.input.length > 0) {
    events.push({
      type: 'response.custom_tool_call_input.delta',
      item_id: itemId,
      output_index: outputIndex,
      delta: item.input,
    });
  }

  events.push({
    type: 'response.custom_tool_call_input.done',
    item_id: itemId,
    output_index: outputIndex,
    input: item.input,
  });
  events.push({
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  });

  return events;
};

const responseWebSearchCallEvents = (item: ResponseOutputWebSearchCall, outputIndex: number): ResponseStreamEvent[] => {
  const { startFrames, endFrames } = webSearchCallLifecycleEvents(item, outputIndex);
  return [...startFrames, ...endFrames];
};

const responseImageGenerationCallEvents = (item: ResponseOutputImageGenerationCall, outputIndex: number): ResponseStreamEvent[] => {
  const { startFrames, endFrames } = imageGenerationCallLifecycleEvents(item, outputIndex);
  return [...startFrames, ...endFrames];
};

const responseGenericOutputItemEvents = (item: ResponseOutputItem, outputIndex: number): ResponseStreamEvent[] => [
  {
    type: 'response.output_item.added',
    output_index: outputIndex,
    item,
  },
  {
    type: 'response.output_item.done',
    output_index: outputIndex,
    item,
  },
];

const responseOutputItemEvents = (item: ResponseOutputItem, outputIndex: number): ResponseStreamEvent[] => {
  switch (item.type) {
  case 'message': return responseMessageEvents(item, outputIndex);
  case 'reasoning': return responseReasoningEvents(item, outputIndex);
  case 'function_call': return responseFunctionCallEvents(item, outputIndex);
  case 'custom_tool_call': return responseCustomToolCallEvents(item, outputIndex);
  case 'web_search_call': return responseWebSearchCallEvents(item, outputIndex);
  case 'image_generation_call': return responseImageGenerationCallEvents(item, outputIndex);
  default: return responseGenericOutputItemEvents(item, outputIndex);
  }
};

export const responsesResultToEvents = (response: ResponsesResult): EventFrame<SequencedResponsesStreamEvent>[] => {
  const started = responseStartSnapshot(response);
  const events: ResponseStreamEvent[] = [
    { type: 'response.created', response: started },
    { type: 'response.in_progress', response: started },
    ...response.output.flatMap(responseOutputItemEvents),
    { type: getTerminalEventName(response), response },
  ];

  return events.map((event, sequenceNumber) => eventFrame({ ...event, sequence_number: sequenceNumber }));
};
