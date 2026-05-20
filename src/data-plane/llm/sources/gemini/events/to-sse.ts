import type { GeminiStreamEvent } from "../../../../shared/protocol/gemini.ts";
import { protocolFramesUntilTerminal } from "../../../shared/stream/protocol-algebra.ts";
import {
  type ProtocolFrame,
  type SseFrame,
  sseFrame,
} from "../../../shared/stream/types.ts";
import {
  geminiSourceStreamAlgebra,
  isGeminiErrorEvent,
  isGeminiFinishedEvent,
} from "./protocol.ts";
import type { TokenUsage } from "../../../../../repo/types.ts";
import { hasTokenUsage } from "../../../../shared/telemetry/usage.ts";
import { tokenUsageFromGeminiResponse } from "../usage.ts";

export const geminiProtocolFrameToSSEFrame = (
  frame: ProtocolFrame<GeminiStreamEvent>,
): SseFrame | null =>
  frame.type === "done" ? null : sseFrame(JSON.stringify(frame.event));

interface GeminiProtocolEventsToSSEFramesOptions {
  onUsage: (usage: TokenUsage) => Promise<void> | void;
}

export const geminiProtocolEventsToSSEFrames = async function* (
  frames: AsyncIterable<ProtocolFrame<GeminiStreamEvent>>,
  options: GeminiProtocolEventsToSSEFramesOptions,
): AsyncGenerator<SseFrame> {
  for await (
    const frame of protocolFramesUntilTerminal(
      frames,
      geminiSourceStreamAlgebra,
    )
  ) {
    if (
      frame.type === "event" && !isGeminiErrorEvent(frame.event) &&
      isGeminiFinishedEvent(frame.event)
    ) {
      const usage = tokenUsageFromGeminiResponse(frame.event);
      if (usage && hasTokenUsage(usage)) await options.onUsage(usage);
    }

    const sse = geminiProtocolFrameToSSEFrame(frame);
    if (sse) yield sse;
  }
};
