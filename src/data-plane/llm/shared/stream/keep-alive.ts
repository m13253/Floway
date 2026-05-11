import { sseCommentFrame, sseFrame, type SseWritableFrame } from "./types.ts";

// Messages has a protocol-level ping event. OpenAI-compatible and Gemini SSE
// consumers should ignore comment frames while intermediaries still see bytes.
export const downstreamSSECommentKeepAliveFrame: SseWritableFrame =
  sseCommentFrame("keepalive");

export const downstreamMessagesPingKeepAliveFrame: SseWritableFrame = sseFrame(
  JSON.stringify({ type: "ping" }),
  "ping",
);
