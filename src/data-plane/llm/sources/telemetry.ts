import type { ProtocolFrame } from "../shared/stream/types.ts";

export interface SourceStreamOutcome {
  failed: boolean;
  completed: boolean;
}

export const trackSourceStreamOutcome = async function* <TEvent>(
  frames: AsyncIterable<ProtocolFrame<TEvent>>,
  outcome: SourceStreamOutcome,
  isFailure: (event: TEvent) => boolean,
  isCompletion: (frame: ProtocolFrame<TEvent>) => boolean,
): AsyncGenerator<ProtocolFrame<TEvent>> {
  for await (const frame of frames) {
    if (frame.type === "event" && isFailure(frame.event)) {
      outcome.failed = true;
    }
    if (isCompletion(frame)) {
      outcome.completed = true;
    }
    yield frame;
  }
};
