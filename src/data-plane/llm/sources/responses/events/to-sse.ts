import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import { protocolEventsUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import {
  responsesSourceStreamAlgebra,
  type SourceResponseStreamEvent,
} from "./protocol.ts";
import type { TokenUsage } from "../../../../../repo/types.ts";
import { hasTokenUsage } from "../../../../shared/telemetry/usage.ts";
import { tokenUsageFromResponsesResult } from "../usage.ts";

export const responsesProtocolEventToSSEFrame = (
  event: SourceResponseStreamEvent,
): SseFrame => sseFrame(JSON.stringify(event), event.type);

interface ResponsesProtocolEventsToSSEFramesOptions {
  onUsage: (usage: TokenUsage) => Promise<void> | void;
}

const isTerminalResponseEvent = (
  event: SourceResponseStreamEvent,
): event is Extract<
  SourceResponseStreamEvent,
  { type: "response.completed" | "response.incomplete" | "response.failed" }
> =>
  event.type === "response.completed" ||
  event.type === "response.incomplete" ||
  event.type === "response.failed";

export const responsesProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<SourceResponseStreamEvent>>,
  options: ResponsesProtocolEventsToSSEFramesOptions,
): AsyncGenerator<SseFrame> {
  for await (
    const event of protocolEventsUntilTerminal(
      frames,
      responsesSourceStreamAlgebra,
    )
  ) {
    if (isTerminalResponseEvent(event)) {
      const usage = tokenUsageFromResponsesResult(event.response);
      if (usage && hasTokenUsage(usage)) await options.onUsage(usage);
    }

    yield responsesProtocolEventToSSEFrame(event);
  }
};
