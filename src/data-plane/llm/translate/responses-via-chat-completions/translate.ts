import { translateToSourceEvents } from './events.ts';
import { buildTargetRequest } from './request.ts';
import type { ChatCompletionChunk, ChatCompletionsPayload } from '../../../shared/protocol/chat-completions.ts';
import type { ResponsesPayload } from '../../../shared/protocol/responses.ts';
import type { ResponsesStreamEvent } from '../../shared/protocol/responses.ts';
import type { TranslateTrip } from '../types.ts';

export const translateResponsesViaChatCompletions: TranslateTrip<
  ResponsesPayload, ResponsesStreamEvent, ChatCompletionsPayload, ChatCompletionChunk
> = async src => {
  // customToolNames is produced inside the request translator (it sees the
  // tools first) and read by the events translator so wrapped function calls
  // can be projected back into `custom_tool_call` outputs.
  const { target, customToolNames } = buildTargetRequest(src);

  return {
    target,
    events: frames => translateToSourceEvents(frames, customToolNames),
  };
};
