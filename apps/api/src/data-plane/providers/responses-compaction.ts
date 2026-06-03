import type { ProviderCallResult } from './types.ts';
import { responsesResultToEvents, type ResponsesResult } from '@floway-dev/protocols/responses';

// A `/responses/compact` upstream answer is a single non-streaming
// `response.compaction` body, but the target pipeline only accepts
// `text/event-stream` (it forces stream=true on every LLM endpoint). Rather
// than teach the pipeline a non-SSE side path, every provider projects its
// compaction envelope onto SSE here, serializing the canonical event sequence
// `responsesResultToEvents` builds. Items expand generically (opaque
// `output_item.added`/`.done`) so the input-shaped retained messages keep their
// role and content rather than being rewritten as assistant output.
export const compactionResultToSse = (result: ResponsesResult): Response => {
  const body = responsesResultToEvents(result, { genericOutputItems: true })
    .map(frame => `event: ${frame.event.type}\ndata: ${JSON.stringify(frame.event)}`)
    .concat('data: [DONE]')
    .join('\n\n');

  return new Response(`${body}\n\n`, { headers: { 'content-type': 'text/event-stream' } });
};

// Upstreams with a native `/responses/compact` (Azure, custom) answer with the
// non-streaming envelope directly; project it onto the SSE the target pipeline
// requires, leaving upstream error responses untouched so the boundary reports
// them verbatim.
export const nativeCompactToSse = async (call: Promise<ProviderCallResult>): Promise<ProviderCallResult> => {
  const result = await call;
  if (!result.response.ok) return result;
  return { response: compactionResultToSse((await result.response.json()) as ResponsesResult), modelKey: result.modelKey };
};
