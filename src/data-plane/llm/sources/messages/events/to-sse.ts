import type { MessagesStreamEventData } from "../../../../shared/protocol/messages.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import { messagesSourceStreamAlgebra } from "./protocol.ts";
import type { TokenUsage } from "../../../../../repo/types.ts";
import { hasTokenUsage } from "../../../../shared/telemetry/usage.ts";

export const messagesProtocolEventToSSEFrame = (
  event: MessagesStreamEventData,
): SseFrame => sseFrame(JSON.stringify(event), event.type);

interface MessagesProtocolEventsToSSEFramesOptions {
  onUsage: (usage: TokenUsage) => Promise<void> | void;
}

const mergeMessageStartUsage = (
  usage: TokenUsage,
  event: MessagesStreamEventData,
): boolean => {
  if (event.type !== "message_start") return false;

  const eventUsage = event.message.usage;
  const cacheReadTokens = eventUsage.cache_read_input_tokens ?? 0;
  const cacheCreationTokens = eventUsage.cache_creation_input_tokens ?? 0;
  usage.inputTokens = eventUsage.input_tokens + cacheReadTokens +
    cacheCreationTokens;
  usage.outputTokens = eventUsage.output_tokens;
  usage.cacheReadTokens = cacheReadTokens;
  usage.cacheCreationTokens = cacheCreationTokens;
  return usage.inputTokens > 0;
};

const mergeMessageDeltaUsage = (
  usage: TokenUsage,
  event: MessagesStreamEventData,
  gotInputFromStart: boolean,
): void => {
  if (event.type !== "message_delta" || !event.usage) return;

  if (!gotInputFromStart && event.usage.input_tokens !== undefined) {
    const cacheReadTokens = event.usage.cache_read_input_tokens ?? 0;
    const cacheCreationTokens = event.usage.cache_creation_input_tokens ?? 0;
    usage.inputTokens = event.usage.input_tokens + cacheReadTokens +
      cacheCreationTokens;
    usage.cacheReadTokens = cacheReadTokens;
    usage.cacheCreationTokens = cacheCreationTokens;
  }
  usage.outputTokens = event.usage.output_tokens;
};

export const messagesProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<MessagesStreamEventData>>,
  options: MessagesProtocolEventsToSSEFramesOptions,
): AsyncGenerator<SseFrame> {
  const usage: TokenUsage = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheCreationTokens: 0,
  };
  let gotInputFromStart = false;

  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      messagesSourceStreamAlgebra,
    )
  ) {
    gotInputFromStart = mergeMessageStartUsage(usage, event) ||
      gotInputFromStart;
    mergeMessageDeltaUsage(usage, event, gotInputFromStart);
    if (event.type === "message_stop" && hasTokenUsage(usage)) {
      await options.onUsage(usage);
    }

    yield messagesProtocolEventToSSEFrame(event);
  }
};
