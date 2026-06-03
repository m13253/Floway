import { sseFrame, type SseFrame } from './sse.ts';

// Test-only fixtures: re-serialize SseFrames into the wire format that
// parseSSEStream consumes. Tests for any protocol stream parser build their
// upstream-frame fixtures with `sseFrameBody(sseFrame(...), sseFrame(...))`,
// then pass the result to the parser under test. Not re-exported from the
// package's `./common` surface — these are only ever consumed via the
// explicit `./common/test-utils.ts` relative import in test files.
export const sseFrameLine = (frame: SseFrame): string =>
  `${frame.event ? `event: ${frame.event}\n` : ''}data: ${frame.data}\n\n`;

export const sseFrameBody = (...frames: SseFrame[]): ReadableStream<Uint8Array> =>
  new Response(frames.map(sseFrameLine).join('')).body!;

// Re-exported for ergonomics so test files can do
// `import { sseFrame, sseFrameBody } from '../common/test-utils.ts'` and not
// thread two imports.
export { sseFrame };
