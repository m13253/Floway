import { sseFrame, type SseFrame } from './sse.ts';

// Test-only helper for constructing a `ReadableStream<Uint8Array>` that
// re-serializes a list of SseFrames into the wire format that
// `parseSSEStream` expects. The protocol stream parsers read from a body,
// so per-protocol tests that want to assert behavior on a sequence of
// upstream frames build them with this helper.
export const sseFrameLine = (frame: SseFrame): string =>
  `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`;

export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  new Response(frames.map(sseFrameLine).join('')).body!;

export const mkSseFrame = (data: string, event?: string): SseFrame => sseFrame(data, event);
